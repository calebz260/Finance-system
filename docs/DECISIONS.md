# Architectural decisions

Each entry records what was decided, why, and what it costs. Decisions that reverse an
earlier one supersede it explicitly rather than quietly replacing it.

---

## ADR-001: Money is `Decimal`/`NUMERIC(14,2)` end to end, never floating point

**Status:** accepted (Phase 0)

Monetary values are arbitrary-precision decimals in the application (`decimal.js`, via the
`Money` value object) and `NUMERIC(14, 2)` in PostgreSQL. Rounding is round-half-up
everywhere, applied at construction, with no per-call-site override. Money crosses the API
boundary as a **string**.

**Why.** IEEE-754 doubles cannot represent 0.1 exactly; summing charges in a float drifts,
and a school ledger that is off by a few francs is not trustworthy. A JSON _number_ would be
re-parsed as a double by any client, so the string form is what keeps precision intact
across the wire. Fixing the scale at 2 rather than 0 keeps the schema consistent if a second
currency is ever needed, even though RWF subunits are not used day to day.

**Cost.** Slightly more ceremony: no `+` on amounts, and `Money.allocate` must be used when
splitting a total so rounding remainders are preserved rather than lost.

**Verified by** `shared/tests/money.test.ts` and a real-engine check in
`backend/tests/integration/database.test.ts`.

---

## ADR-002: Multi-school from day one

**Status:** accepted (Phase 0)

Every core table carries a `school_id`, and scoping is applied by shared repository helpers
rather than trusted to individual queries.

**Why.** One column and one scoping layer now; a data migration across live financial
records later. The specification is explicit that this must not be skipped because only one
school uses the system at launch. Enforcing it in the repository layer — not the UI — is what
makes "a bursar cannot read another school's data" true rather than merely invisible.

**Cost.** Every query carries a scope argument, and the scoping helper must be used
consistently. Phase 1 introduces the column; Phase 2 binds the acting user's school into the
request context.

---

## ADR-003: Manual/offline payment verification is a first-class workflow

**Status:** accepted (Phase 0, implemented in Phase 5)

The manual path (bank slip, cash, SACCO remittance) gets the same rigour as the
provider-processed path: its own entities, states, verification step, statement import and
reconciliation.

**Why.** The problem this system exists to solve _is_ manual fee-slip verification. Two of
the three named channels — Zigama CSS and Umwarimu SACCO — are very likely
statement-reconciled rather than live-API, so the manual path may carry most of the real
transaction volume. Treating it as an exception path would mean building the wrong system.

**Consequence.** A manual claim never touches the ledger until an authorised bursar confirms
it against a statement, and the confirming user should not be the submitting user.

---

## ADR-004: Prisma 7 with the `pg` driver adapter

**Status:** accepted (Phase 0)

PostgreSQL through Prisma 7, connected via `@prisma/adapter-pg`. The connection URL lives in
`backend/prisma.config.ts` for CLI commands and is supplied to the adapter at runtime.

**Why.** Prisma 7 removed `url` from `datasource` and requires a driver adapter, so this is
the supported shape rather than a preference. It has a genuine benefit: the connection pool
is configured explicitly in application code (bounded `max`, idle recycling, fail-fast
connect timeout) instead of through connection-string parameters, and no stray schema file
can point a migration at the wrong database.

**Cost.** Generated client output lives in `backend/src/generated/` and is git-ignored, so
`prisma generate` must run before typecheck, test and build. The `pre*` npm hooks do this
automatically; CI does it as an explicit step.

---

## ADR-005: Timestamps stored in UTC, displayed in Africa/Kigali

**Status:** accepted (Phase 0)

Every timestamp is stored as `timestamptz` in UTC. Conversion to Africa/Kigali (UTC+2, no
DST) happens only in the presentation layer, in one module (`frontend/src/lib/format.ts`).

**Why.** Receipts, reports and audit logs must agree on what time something happened. Storing
local time invites ambiguity and makes cross-checking a bank statement harder. Converting in
exactly one place means a receipt and an audit entry cannot disagree.

**Verified by** an integration test asserting the database session time zone is UTC.

---

## ADR-006: Type-aware linting is on

**Status:** accepted (Phase 0)

ESLint runs with `recommendedTypeChecked` and `projectService`, including
`no-floating-promises` and `no-misused-promises`.

**Why.** The rules it unlocks catch the faults that actually matter here: an un-awaited
database write, an async handler passed where a sync one is expected, a `Decimal` implicitly
stringified into a template. Those show up as a wrong balance, not as a crash, which makes
them the expensive kind of bug.

**Cost.** Linting is slower, and generated code must be excluded.

---

## ADR-007: Validation output goes on `req.valid`, not over `req.body`

**Status:** accepted (Phase 0)

`validate(schemas)` attaches parsed and coerced data to `req.valid`, read through
`validated<T>(req)`.

**Why.** Express 5 exposes `req.query` through a getter, so overwriting it is not reliable;
and keeping the raw input intact means later middleware can still see exactly what the client
sent. All declared parts are validated before failing, so a user gets every field problem at
once instead of discovering them one reload at a time. If the middleware is ever missed on a
route, `validated()` throws immediately rather than letting `undefined` travel into a service.

---

## ADR-008: One `DataState` component owns loading, error, empty and success

**Status:** accepted (Phase 0)

**Why.** "Loading/error/empty states on every page" is a requirement that decays if each page
implements it by hand. Centralising it means a screen cannot ship missing one. It also keeps
an important distinction visible: "no payments recorded today" (empty) is normal, and a bursar
must be able to tell it apart from "payments failed to load" (error).

---

## ADR-009: Money formatting, but never money arithmetic, in the browser

**Status:** accepted (Phase 0)

The web client may construct and format `Money`; it must never derive a balance.

**Why.** A balance computed in two places will eventually disagree in one of them, and the
server is the only side that can be trusted or audited. `formatMoney` renders an invalid
figure as an em dash rather than throwing, so one malformed value cannot blank an entire
payments table.

---

## ADR-010: A separate test database, and tests that fail loudly without it

**Status:** accepted (Phase 0)

Integration tests use `TEST_DATABASE_URL`, run serially, and are not skipped when PostgreSQL
is absent.

**Why.** A suite that silently skips the database is worse than no suite: it reports green
while proving nothing. Running serially prevents suites from interleaving transactions and
truncations against the same schema. The separate database means a test reset can never
truncate development data.
