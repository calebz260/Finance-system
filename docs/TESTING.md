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

**Phase 5** — every one of the above, and all of it asserted against the **balance** rather
than against a status field, because a double credit shows up there even when each individual
record looks correct.

| Suite                                        | What it holds the line on                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/payment-status.test.ts`                | The status machine: no exit from a terminal state, SUCCESSFUL reachable only from a live one, and a repeat classified as already-applied rather than as a fault.    |
| `unit/file-storage.test.ts`                  | What an upload is judged to be (its bytes, never its name), the opaque storage key, and the size and type refusals. Real files, written and read back.              |
| `unit/matching.test.ts`                      | That the matcher declines to guess: a quoted reference with a different amount is _not_ a match, two equal candidates are ambiguity, money out is never attributed. |
| `unit/statement-parser.test.ts`              | The shapes real bank exports arrive in — credits-only, separate credit/debit columns, a signed amount, thousands separators, accounting parentheses.                |
| `integration/payments.test.ts`               | The whole payment path over HTTP, including the cases below.                                                                                                        |
| `integration/reconciliation.test.ts`         | Import, automatic matching, the duplicate-file refusal, match-and-credit, and the refusals around a credited line.                                                  |
| `frontend/pages/PaymentDetailPage.test.tsx`  | That the statement amount is typed rather than pre-filled, and that a decision carries the version the screen was showing.                                          |
| `frontend/pages/ReconciliationPage.test.tsx` | That a candidate whose amount differs cannot be accepted at all, and that crediting is a separate, confirmed action.                                                |

The cases worth naming individually, because each of them is a way a school could be told the
wrong thing about its own money:

- a provider callback delivered **three times** produces exactly **one** ledger entry;
- two _distinct_ callbacks both reporting success also produce one;
- a forged signature and a stale timestamp are both refused, both recorded in
  `payment_webhook_events`, and both credit nothing;
- a confirmation whose amount disagrees with the claim credits **neither** figure and parks the
  payment for review;
- a success reported with **no** amount is held rather than assumed to be the amount requested;
- a late "success" cannot resurrect a payment that already failed;
- the bursar who recorded a claim cannot confirm it, and the blocked attempt is audited;
- a parent reaches their own children and nobody else's — asserted as a 404, not a 403, so the
  test also pins down that the refusal discloses nothing;
- a reversal posts an opposing entry, leaves the original intact, and cannot be applied twice;
- an idempotency key replays the original payment, and the same key on a different request is
  refused;
- two identical requests arriving **together** produce one payment and one provider attempt —
  the race the key exists for, exercised with `Promise.all` rather than described in a comment;
- a payment whose provider accepted the request and then went quiet can be parked by a bursar
  and resolved from there, in two deliberate steps;
- a statement line and a payment of different amounts cannot be matched at all;
- a line that has credited a payment cannot be detached from it.

**Phase 9** — batch promotion; mid-term withdrawal proration under each configured policy.

**Phase 13** — concurrent edits to one financial account genuinely trigger optimistic-locking
rejection rather than a silent last-write-wins.

## CI

`.github/workflows/ci.yml` runs on every push and pull request against `main`: install, build
shared, generate the Prisma client, format check, lint, typecheck, apply migrations, run all
three test suites against a real PostgreSQL 17 service container, then build. Merging is
gated on this passing.
