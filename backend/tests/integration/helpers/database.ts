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
  // Authentication state. `CASCADE` from `users` would reach these anyway, but listing
  // them keeps the reset explicit rather than relying on the direction of a foreign key
  // that a later migration could change.
  'password_reset_tokens',
  'mfa_recovery_codes',
  'refresh_tokens',
  'sessions',
  // Reconciliation, before payments: a statement line points at the payment it was
  // attributed to.
  'bank_statement_lines',
  'bank_statement_imports',
  // Payments, before the ledger: a financial entry points at a payment, and a payment
  // points at an account, a student and a period. The webhook log goes first because it
  // references both a payment and one of its attempts.
  'payment_webhook_events',
  'payment_evidence',
  'payment_status_history',
  'payment_transactions',
  'payments',
  // Financial tables, listed before the academic ones they reference. The ledger goes
  // first: an entry points at a charge, an account and a relief record, so emptying it
  // last would rely on CASCADE arriving from three directions.
  'financial_entries',
  'student_financial_accounts',
  'financial_adjustments',
  'fee_waivers',
  'student_scholarships',
  'scholarships',
  'discounts',
  'student_charges',
  'charge_runs',
  'fee_structure_items',
  'fee_structures',
  'fee_categories',
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
