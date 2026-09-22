/**
 * Fixtures for the authentication and authorisation suites.
 *
 * These build real rows — schools, the seeded role and permission catalogue, users with
 * Argon2id hashes and encrypted TOTP secrets — and drive sign-in over real HTTP. Nothing
 * here stubs the auth layer: a test that mocked its way to a principal would prove
 * nothing about whether the middleware admits the right people.
 */
import { TOTP, Secret } from 'otpauth';
import request from 'supertest';
import type { Express } from 'express';

import { PERMISSIONS, ROLE_DEFINITIONS, type RoleKey } from '@sfs/shared';

import type { UserStatus } from '../../../src/generated/prisma/enums.js';
import { encryptSecret, hashRecoveryCode } from '../../../src/lib/crypto.js';
import { hashPassword } from '../../../src/lib/password.js';
import { prisma } from '../../../src/lib/prisma.js';
import { generateTotpSecret } from '../../../src/lib/totp.js';

/** Long enough for the policy, and not derived from any test account's identity. */
export const TEST_PASSWORD = 'Turquoise-Lantern-88';

/**
 * Insert the permission and role catalogue.
 *
 * Derived from the shared definitions, exactly as the production seed is, so a test
 * asserting that a Bursar cannot approve an adjustment is asserting against the real
 * matrix rather than one written to suit the test.
 */
export async function seedRoleCatalogue(): Promise<Map<string, string>> {
  await prisma.permission.createMany({
    data: PERMISSIONS.map((permission) => ({
      key: permission.key,
      resource: permission.resource,
      action: permission.action,
      description: permission.description,
      isSensitive: permission.isSensitive,
    })),
    skipDuplicates: true,
  });

  const permissionIds = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map((row) => [
      row.key,
      row.id,
    ]),
  );

  const roleIds = new Map<string, string>();

  for (const definition of ROLE_DEFINITIONS) {
    const role = await prisma.role.create({
      data: {
        key: definition.key,
        name: definition.name,
        description: definition.description,
        rank: definition.rank,
        isSystem: true,
        requiresMfa: definition.requiresMfa,
      },
    });
    roleIds.set(definition.key, role.id);

    await prisma.rolePermission.createMany({
      data: definition.permissions.map((key) => ({
        roleId: role.id,
        permissionId: permissionIds.get(key)!,
      })),
      skipDuplicates: true,
    });
  }

  return roleIds;
}

/**
 * A school, with the settings row every school has in production.
 *
 * The settings row is created here rather than left out because it is where the payment
 * policy lives — the currency, the minimum payment, whether part payments are accepted,
 * whether verification requires a second person. A fixture without it would let a test
 * exercise those rules against fallback defaults instead of against a real row, which is
 * not what the deployed system would do.
 */
export async function createSchool(code: string, name: string): Promise<string> {
  const school = await prisma.school.create({
    data: { code, name, settings: { create: {} } },
  });
  return school.id;
}

export interface CreateTestUserOptions {
  readonly email: string;
  readonly roleKeys: readonly RoleKey[];
  readonly schoolId: string | null;
  readonly password?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly status?: UserStatus;
  readonly mustChangePassword?: boolean;
  readonly isSystemAdministrator?: boolean;
  /**
   * Enrol a TOTP secret. Defaults to true whenever a held role requires MFA, because
   * such an account cannot reach a session otherwise — it is routed into enrolment.
   * Set false deliberately to exercise that path.
   */
  readonly enrolMfa?: boolean;
  /** Plaintext recovery codes to store hashes of. */
  readonly recoveryCodes?: readonly string[];
}

export interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly schoolId: string | null;
  readonly roleKeys: readonly RoleKey[];
  /** Present when MFA was enrolled. */
  readonly mfaSecret?: string;
}

export async function createTestUser(
  roleIds: Map<string, string>,
  options: CreateTestUserOptions,
): Promise<TestUser> {
  const password = options.password ?? TEST_PASSWORD;
  const requiresMfa = options.roleKeys.some(
    (key) => ROLE_DEFINITIONS.find((role) => role.key === key)?.requiresMfa === true,
  );
  const enrolMfa = options.enrolMfa ?? requiresMfa;
  const mfaSecret = enrolMfa ? generateTotpSecret() : undefined;

  const user = await prisma.user.create({
    data: {
      email: options.email.toLowerCase(),
      firstName: options.firstName ?? 'Test',
      lastName: options.lastName ?? 'Account',
      passwordHash: await hashPassword(password),
      schoolId: options.schoolId,
      status: options.status ?? 'ACTIVE',
      mustChangePassword: options.mustChangePassword ?? false,
      isSystemAdministrator: options.isSystemAdministrator ?? false,
      ...(mfaSecret !== undefined
        ? {
            mfaEnabled: true,
            mfaSecretEncrypted: encryptSecret(mfaSecret),
            mfaEnrolledAt: new Date(),
          }
        : {}),
    },
  });

  for (const key of options.roleKeys) {
    await prisma.userRole.create({
      data: {
        userId: user.id,
        roleId: roleIds.get(key)!,
        schoolId: key === 'SUPER_ADMIN' ? null : options.schoolId,
      },
    });
  }

  if (options.recoveryCodes !== undefined) {
    await prisma.mfaRecoveryCode.createMany({
      data: options.recoveryCodes.map((code) => ({
        userId: user.id,
        codeHash: hashRecoveryCode(code),
      })),
    });
  }

  return {
    id: user.id,
    email: user.email,
    password,
    schoolId: user.schoolId,
    roleKeys: options.roleKeys,
    ...(mfaSecret !== undefined ? { mfaSecret } : {}),
  };
}

/** A code as the user's authenticator app would show it. */
export function totpCodeFor(secret: string, timestamp: number = Date.now()): string {
  return new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate({ timestamp });
}

export interface Session {
  readonly accessToken: string;
  /** The `Set-Cookie` values from the sign-in, to replay on a refresh call. */
  readonly cookies: string[];
  readonly userId: string;
}

/** The refresh cookie from a response, in the form supertest wants back. */
export function cookiesFrom(response: request.Response): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

/**
 * Sign in over HTTP, completing the second factor when one is demanded.
 *
 * Returns the access token and cookies, so a test reads like the client would behave
 * rather than reaching into the session table.
 */
export async function signIn(app: Express, user: TestUser): Promise<Session> {
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: user.email, password: user.password });

  if (login.status !== 200) {
    throw new Error(
      `Sign-in failed for ${user.email}: ${String(login.status)} ${JSON.stringify(login.body)}`,
    );
  }

  if (login.body.data.status === 'authenticated') {
    return {
      accessToken: login.body.data.accessToken,
      cookies: cookiesFrom(login),
      userId: user.id,
    };
  }

  if (login.body.data.status !== 'mfa_required') {
    throw new Error(
      `Expected a session or an MFA challenge for ${user.email}, got ${String(login.body.data.status)}`,
    );
  }

  if (user.mfaSecret === undefined) {
    throw new Error(`${user.email} was challenged for MFA but has no enrolled secret`);
  }

  const verified = await request(app)
    .post('/api/v1/auth/mfa/verify')
    .send({ challengeToken: login.body.data.challengeToken, code: totpCodeFor(user.mfaSecret) });

  if (verified.status !== 200) {
    throw new Error(
      `MFA verification failed for ${user.email}: ${String(verified.status)} ${JSON.stringify(verified.body)}`,
    );
  }

  return {
    accessToken: verified.body.data.accessToken,
    cookies: cookiesFrom(verified),
    userId: user.id,
  };
}

/** `Authorization` header value for a session. */
export function bearer(session: Session): string {
  return `Bearer ${session.accessToken}`;
}
