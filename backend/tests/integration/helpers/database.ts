/**
 * Integration-test database helpers.
 *
 * `resetDatabase` truncates every domain table and restarts identity, which is why the
 * integration project points at a dedicated `TEST_DATABASE_URL` and runs serially.
 *
 * Truncation order does not matter because `CASCADE` is used, but the table list is
 * explicit rather than discovered at runtime: a `TRUNCATE` built from a catalogue query
 * would silently start emptying tables a future migration adds, including ones a test
 * meant to keep.
 */
import { prisma } from '../../../src/lib/prisma.js';

const DOMAIN_TABLES = [
  'audit_logs',
  'enrollments',
  'student_guardians',
  'guardians',
  'students',
  'class_sections',
  'terms',
  'academic_years',
  'levels',
  'programs',
  'departments',
  'user_roles',
  'role_permissions',
  'permissions',
  'roles',
  'users',
  'identifier_sequences',
  'school_settings',
  'schools',
] as const;

export async function resetDatabase(): Promise<void> {
  const list = DOMAIN_TABLES.map((table) => `"${table}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Guard against a catastrophic mistake: a test run must never truncate a database that
 * is not the test database. Called once per suite that resets data.
 */
export async function assertTestDatabase(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  const name = rows[0]?.name ?? '';
  if (!name.includes('test') && !name.includes('ci')) {
    throw new Error(
      `Refusing to run destructive tests against database "${name}". ` +
        'Set TEST_DATABASE_URL to a dedicated test database.',
    );
  }
}
