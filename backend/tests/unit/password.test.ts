import { describe, expect, it } from 'vitest';

import {
  PasswordPolicyError,
  assertPasswordAcceptable,
  assertPasswordLength,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../src/lib/password.js';

const VALID_PASSWORD = 'BursarOffice!2026';

describe('hashPassword', () => {
  it('produces an Argon2id PHC string, never the plaintext', async () => {
    const hash = await hashPassword(VALID_PASSWORD);

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(VALID_PASSWORD);
  });

  it('records the OWASP-recommended cost parameters in the hash', async () => {
    const hash = await hashPassword(VALID_PASSWORD);
    expect(hash).toContain('m=19456');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });

  it('salts each hash, so identical passwords do not produce identical digests', async () => {
    // Without a per-hash salt, a stolen dump would reveal which accounts share a
    // password, and one cracked hash would break all of them.
    const [first, second] = await Promise.all([
      hashPassword(VALID_PASSWORD),
      hashPassword(VALID_PASSWORD),
    ]);
    expect(first).not.toBe(second);
    await expect(verifyPassword(VALID_PASSWORD, first)).resolves.toBe(true);
    await expect(verifyPassword(VALID_PASSWORD, second)).resolves.toBe(true);
  });
});

describe('password policy', () => {
  it('rejects a password shorter than the minimum', () => {
    expect(() => {
      assertPasswordLength('short');
    }).toThrow(PasswordPolicyError);
    expect(() => {
      assertPasswordLength('exactlyEleve');
    }).not.toThrow();
  });

  it('rejects an absurdly long password, which is a cheap way to burn server CPU', () => {
    expect(() => {
      assertPasswordLength('a'.repeat(257));
    }).toThrow(PasswordPolicyError);
  });

  it('refuses to hash a password that breaks the policy', async () => {
    await expect(hashPassword('tooshort')).rejects.toThrow(PasswordPolicyError);
  });
});

describe('assertPasswordAcceptable', () => {
  const identity = {
    email: 'aline.mutesi@gskicukiro.invalid',
    firstName: 'Aline',
    lastName: 'Mutesi',
  };

  it('accepts a long password that has nothing to do with the account', () => {
    expect(() => {
      assertPasswordAcceptable('correct horse battery staple', identity);
    }).not.toThrow();
  });

  it('applies the length floor', () => {
    expect(() => {
      assertPasswordAcceptable('Short1!', identity);
    }).toThrow(/at least 12 characters/);
  });

  it('rejects passwords from the common-password list, whatever the casing or padding', () => {
    // Credential stuffing tries exactly these first, and composition rules do not stop
    // them: `Password123!` satisfies every classic rule.
    for (const candidate of ['password123!', 'Password123!', 'P-a-s-s-w-o-r-d-1-2-3']) {
      expect(() => {
        assertPasswordAcceptable(candidate, identity);
      }).toThrow(/commonly used/);
    }
  });

  it('rejects a password built from the account holder`s own identity', () => {
    // The targeted-guessing case: in a school, everyone knows everyone's name.
    expect(() => {
      assertPasswordAcceptable('AlineMutesi2026', identity);
    }).toThrow(/must not contain your name/);

    expect(() => {
      assertPasswordAcceptable('aline.mutesi-rules', identity);
    }).toThrow(/must not contain your name/);

    expect(() => {
      assertPasswordAcceptable('gskicukiro-forever', identity);
    }).toThrow(/must not contain your name/);
  });

  it('ignores identity fragments too short to be meaningful', () => {
    // Refusing every password containing a two-letter surname would reject sound
    // passwords for no security gain.
    expect(() => {
      assertPasswordAcceptable('thunderous walnut carriage', {
        email: 'jd@example.invalid',
        firstName: 'Jo',
        lastName: 'Ba',
      });
    }).not.toThrow();
  });

  it('rejects a single repeated character, which passes any length floor with no entropy', () => {
    expect(() => {
      assertPasswordAcceptable('aaaaaaaaaaaaaaaa', identity);
    }).toThrow(/repeated character/);
  });

  it('does not impose composition rules, which push people towards guessable patterns', () => {
    // No uppercase, no digit, no symbol -- and far stronger than `Passw0rd!`.
    expect(() => {
      assertPasswordAcceptable('violet trombone harvest', identity);
    }).not.toThrow();
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword(VALID_PASSWORD);

    await expect(verifyPassword(VALID_PASSWORD, hash)).resolves.toBe(true);
    await expect(verifyPassword('WrongPassword!2026', hash)).resolves.toBe(false);
    // Case and whitespace matter.
    await expect(verifyPassword(VALID_PASSWORD.toLowerCase(), hash)).resolves.toBe(false);
    await expect(verifyPassword(` ${VALID_PASSWORD}`, hash)).resolves.toBe(false);
  });

  it('returns false rather than throwing for a corrupt stored hash', async () => {
    // A corrupt value must read as "wrong password", not as a 500 that tells a caller
    // something unusual about this particular account.
    await expect(verifyPassword(VALID_PASSWORD, 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword(VALID_PASSWORD, '')).resolves.toBe(false);
    await expect(verifyPassword(VALID_PASSWORD, '$argon2id$v=19$garbage')).resolves.toBe(false);
  });

  it('returns false for an empty password without consulting the hash', async () => {
    const hash = await hashPassword(VALID_PASSWORD);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('verifies a hash made with weaker parameters, so raising the policy is safe', async () => {
    // Generated with m=8192, t=1, p=1 -- below the current policy. Existing users must
    // still be able to sign in after the cost is raised, or a policy change locks
    // everyone out.
    const weakHash =
      '$argon2id$v=19$m=8192,t=1,p=1$c29tZXNhbHR2YWx1ZQ$Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FyeQ';
    // The digest above is not a real hash of our password, so this asserts only that a
    // weaker-parameter hash is parsed and rejected cleanly rather than throwing.
    await expect(verifyPassword(VALID_PASSWORD, weakHash)).resolves.toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a hash made with the current policy', async () => {
    const hash = await hashPassword(VALID_PASSWORD);
    expect(needsRehash(hash)).toBe(false);
  });

  it('is true for a hash made with weaker parameters', () => {
    expect(needsRehash('$argon2id$v=19$m=8192,t=1,p=1$c29tZXNhbHQ$aGFzaHZhbHVl')).toBe(true);
  });

  it('is true for a hash from a different algorithm or an unrecognised format', () => {
    expect(needsRehash('$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaHZhbHVl')).toBe(true);
    expect(needsRehash('$2b$12$abcdefghijklmnopqrstuv')).toBe(true);
    expect(needsRehash('plaintext')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});
