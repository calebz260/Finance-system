# Testing

## Running tests

```bash
npm test                                   # every workspace
npm test --workspace @sfs/shared           # money, identifiers, API contract
npm test --workspace @sfs/backend          # unit + integration
npm test --workspace @sfs/frontend         # components + API client
npm run test:unit --workspace @sfs/backend        # no database needed
npm run test:integration --workspace @sfs/backend # needs PostgreSQL
npm run test:watch --workspace @sfs/backend
```

Integration tests need the database running:

```bash
npm run db:up
```

`npm run verify` runs the whole gate — format check, lint, typecheck, tests, build — which is
exactly what CI runs.

## Layers

| Project               | Scope                                                                      | Needs a database | Notes                                                                        |
| --------------------- | -------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `@sfs/shared`         | `Money`, identifiers, pagination and envelope helpers                      | no               | Fastest and the most safety-critical: every monetary rule lives here.        |
| backend `unit`        | Config validation, crypto, TOTP, tokens, authorisation middleware, logging | no               | Runs in parallel.                                                            |
| backend `integration` | The real Express app over HTTP, and real PostgreSQL                        | **yes**          | Serial (`fileParallelism: false`), so suites cannot interleave transactions. |
| `@sfs/frontend`       | Components and the API client, via Testing Library and a `fetch` stub      | no               | jsdom.                                                                       |

## Conventions

- **Tests assert behaviour, not implementation.** A test that only restates the code it
  covers gives false confidence.
- **The integration suite uses a separate database** (`TEST_DATABASE_URL`) because a test run
  truncates it. It must never point at development or production data.
- **Database tests fail loudly when PostgreSQL is missing.** They are not skipped: a suite
  that silently skips is worse than no suite, because it reports green while proving nothing.
- **`fetch` is stubbed by hand** (`frontend/src/tests/fetch-mock.ts`) rather than relying on a
  global `Response`/`Headers` implementation, so the same tests behave identically under jsdom
  and plain Node.
- **Every fixed bug gets a regression test.** Two Phase 0 examples, both found by running the
  server rather than by reading the code:
  - a malformed-JSON rejection had no request id, because body parsing ran before the
    request-context middleware;
  - the error log contained the raw request body, because Pino's default error serialiser
    copies every own property and body-parser attaches the payload to its errors.

## Coverage expectations by phase

Financial correctness is not covered by "the endpoint returned 200". Each phase must test the
rules that can silently produce a wrong number:

**Phase 1–3** — schema relationships and cascade behaviour; `school_id` scoping actually
prevents cross-school reads; Student ID uniqueness and format; enrolment history is appended,
never overwritten.

**Phase 2** — every role against every protected operation, including the negative cases;
MFA required for the four high-privilege roles; brute-force lockout; token expiry and reuse.

Where those live:

| Suite                                      | What it holds the line on                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `integration/auth-login.test.ts`           | Sign-in, indistinguishable failures, lockout, MFA verification and enrolment, replay. |
| `integration/auth-session.test.ts`         | What a session grants, refresh rotation, reuse detection, every way a session ends.   |
| `integration/auth-password.test.ts`        | Change and reset, the policy, single-use tokens, and what a reset request may reveal. |
| `integration/authorization.test.ts`        | The role matrix, tenant scoping, and the escalation defences on role assignment.      |
| `unit/authorize.test.ts`                   | The middleware itself, with the audit writer stubbed.                                 |
| `unit/token.service.test.ts`               | Audience separation — the property that makes MFA mandatory rather than advisory.     |
| `unit/crypto.test.ts`, `unit/totp.test.ts` | Tamper rejection, replay refusal, recovery-code normalisation.                        |
| `frontend/lib/api-client.auth.test.ts`     | Silent renewal: once, only on expiry, and never twice in parallel.                    |

Two conventions specific to these suites. **Nothing in the auth layer is mocked** — the
integration tests build real users with real Argon2id hashes and encrypted TOTP secrets, and
sign in over HTTP, because a test that mocked its way to a principal would prove nothing
about who the middleware admits. And **the negative cases matter more than the positive
ones**: a permission granted too widely produces no error and no symptom until someone uses
it.

**Phase 3** — Student ID allocation under concurrency and across schools; enrolment history
appended rather than overwritten; a student status change ending the live enrolment; the
guardian link flags that later become authorisation inputs; and the bulk import, which is
tested against a realistically messy file and against a full 1,000-row run through the real
transaction, because the row count is itself a property worth asserting.

**Phase 4** — fee calculation per term; discounts, scholarships and waivers; adjustment
authorisation; historical fee structures preserved when a new period is created.

The balance formula is tested as a **pure function over ledger rows**
(`tests/unit/balance.test.ts`), without a database. That is deliberate: if the arithmetic is
wrong then every screen, report and clearance decision built on it is wrong in the same way, and
the error lands in the second decimal place where nobody notices until a parent does. Testing it
in isolation means the boundary cases worth having — an overpayment, a reversal, 0.1 + 0.2, the
largest storable amount, a percentage that does not divide evenly — can all be asserted in
milliseconds instead of through HTTP.

Everything that touches money is then asserted end to end against a real database
(`tests/integration/fees.test.ts`): that re-running generation does not double-charge, that a
day student is never charged for boarding, that relief never edits the charge it reduces, that a
void posts an opposing entry rather than deleting a row, and that a Finance Manager cannot
approve their own request. The assertion in most of those is the **balance**, not a row count —
a double charge shows up there even when every individual record looks right.

**Phase 5** — successful, failed, pending, cancelled, reversed and refunded payments; a
duplicate webhook does not double-credit; an invalid signature is rejected; a mismatched
amount or reference is rejected; replayed webhooks are rejected; idempotency keys prevent
duplicate transactions; a manual claim does not affect the ledger until confirmed; confirm
and reject paths both audit correctly; statement import matches and flags exceptions.

**Phase 9** — batch promotion; mid-term withdrawal proration under each configured policy.

**Phase 13** — concurrent edits to one financial account genuinely trigger optimistic-locking
rejection rather than a silent last-write-wins.

## CI

`.github/workflows/ci.yml` runs on every push and pull request against `main`: install, build
shared, generate the Prisma client, format check, lint, typecheck, apply migrations, run all
three test suites against a real PostgreSQL 17 service container, then build. Merging is
gated on this passing.
