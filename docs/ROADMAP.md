# Roadmap and status

The target is the complete Version 1 system, not an MVP. Work proceeds phase by phase; a
phase is complete only when implementation, migrations, frontend/backend wiring, validation,
authorisation, tests passing in CI, error handling, documentation and a reviewed commit are
all done.

**Legend:** ✅ complete · 🚧 in progress · ⬜ not started

---

## ✅ Phase 0 — Project foundation

Monorepo, typed configuration, error hierarchy, structured logging, request context,
validation middleware, rate limiting, Prisma 7 + PostgreSQL wiring, the `Money` value object,
React app shell with a live backend-connected page, ESLint/Prettier, Vitest harness and the
CI gate.

**Delivered:** 107 tests passing (shared 44, backend 52, frontend 16 at time of writing);
format, lint, typecheck, test and build green locally and in CI; PostgreSQL 17 reachable;
runtime chain verified end to end (`UI → API client → Express → Prisma → PostgreSQL → UI`).

**Not included, by design:** authentication, the domain schema, payments, reporting. See the
last section of [ARCHITECTURE.md](ARCHITECTURE.md).

---

## ✅ Phase 1 — Database and core domain

Schools, users, roles, permissions, students, parents/guardians, student–parent relationships,
academic years, **terms**, levels, classes, programmes/trades, departments, enrolments — with
`school_id` scoping from the first migration. Migrations, realistic seed data, relationship
tests.

Conventions already fixed: `Decimal(14,2)` money, `timestamptz` UTC, UUID keys, snake_case
table names, `version` columns for optimistic locking on co-edited rows.

**Delivered:** the full domain schema across three migrations, the shared role and permission
catalogue, seed data for a realistic school, the `AccessScope` tenant-scoping layer, the
identifier sequence behind Student IDs, and the student repository as the reference
implementation every later module follows.

## ✅ Phase 2 — Authentication and authorisation

Login, logout, password hashing (Argon2id), password reset, session/token management, **TOTP
MFA for Bursar, Finance Manager, School Administrator and Super Administrator**, RBAC with
backend enforcement, protected routes, account status, brute-force protection. Every role
tested for what it may and may not do.

**Delivered:**

- Argon2id hashing with opportunistic rehash, and a NIST-shaped password policy (length floor,
  common-password blocklist, no password built from the account&#39;s own identity) applied
  wherever a password is _set_ and never where one is _presented_.
- Server-side sessions with rotating refresh tokens. A consumed token presented again revokes
  the whole session and is audited, because replay and theft are indistinguishable from the
  request.
- TOTP enrolment, verification and single-use recovery codes. Secrets are AES-256-GCM encrypted
  at rest; an accepted step counter is stored so an observed code cannot be used twice.
  Enrolment is forced at sign-in for the four high-privilege roles.
- Per-account lockout that a failed _second_ factor also counts towards, alongside the per-IP
  auth rate limiter — the two cover different attacks.
- Password reset through a single-use, hashed, short-lived token delivered over a port. The
  request step answers identically for a known address, an unknown one and a suspended account.
- Backend-enforced RBAC: permissions re-read from the database on every request, tenant scope
  derived from the user rather than the token, and denials audited.
- Account administration (`/users`, `/roles`) with separation of duties: nobody edits their
  own roles, nobody grants above their own rank, nobody suspends themselves, and the last
  active Super Administrator cannot be removed.
- Web client: sign-in including both MFA paths, forced password change, reset, session list,
  route guards, and an accounts screen — with the access token held in memory and renewed
  silently through the httpOnly refresh cookie.

**Test coverage:** 225 backend integration tests, 122 backend unit tests, 44 frontend tests,
all green in CI.

**Deferred with a reason:** reset links are not yet emailed — no notification channel exists
until Phase 6, so `PasswordResetDelivery` logs in development and reports loudly elsewhere.
Editing a role&#39;s permissions at runtime (`role.manage`) has a permission but no endpoint;
changing the matrix for everyone holding a role deserves its own design.

## ✅ Phase 3 — Student and academic management

Student registration and Student ID allocation, student profile, parent linking, classes,
programmes, levels, academic years and terms, enrolment history, student status, and the
**bulk CSV/Excel import** for the school's existing ~1,000+ students with a
validation-and-preview step and row-level error reporting.

**Delivered:**

- Academic structure — years, terms, departments, programmes, levels and classes — with the
  invariants every later phase depends on: exactly one current year and one current term, a
  term that lies inside its year and overlaps no sibling, a closed period that cannot be
  reopened, and a level chain that is single-successor and acyclic because promotion walks it.
- Student registration with the Student ID allocated from the per-school counter inside the
  same transaction as the insert, and the first enrolment created alongside it — a student
  with no enrolment cannot be charged, placed or reported on.
- Profile editing that cannot touch the Student ID or the status; a lifecycle endpoint that
  validates the transition and ends the live enrolment when the student leaves; and enrolment
  history that is appended, never overwritten.
- Guardians, and the student–guardian link carrying the financial rights Section 26 turns into
  authorisation: who the school rings, who pays, who may see a balance, who may pay online.
  Exactly one primary contact per student, and every change to those flags audited with its
  before and after.
- **Bulk import** of `.csv` and `.xlsx`, in two steps. A preview writes nothing and reports
  every problem against the row number the registrar sees on screen; the commit applies in one
  transaction and refuses by default if any row failed. Column headings are matched by alias,
  dates are read in the three formats these files contain, and a parent repeated across
  siblings is recognised by normalised phone number and linked once rather than duplicated.
- Web client: the student roll with search and class filters, registration, the student page
  with guardians and history, the import wizard, and the academic-setup screen.

**Test coverage:** 468 backend tests — including a 1,000-row import through the real
transaction — and 52 frontend tests. The full local verification gate (format, lint,
typecheck, test, build) passes against PostgreSQL 17; CI has not yet run this phase.

**Deferred with a reason:** uploaded files are parsed in memory and discarded. Persistent
upload storage, its path rules and malware scanning belong to Phase 5, which owns file
handling, and this feature deliberately does not pre-empt that design. Promotion itself is
Phase 9; the level chain it walks is in place and tested here.

_Outcome:_ Phase 5 kept this decision for import files rather than reversing it. Statements are
parsed in memory too; only proof of payment — the evidence behind a credit rather than a means
of getting data in — is stored (ADR-027).

## ✅ Phase 4 — Fee management

Fee structures scoped by **academic year + term + level/class + programme**, fee items,
student charges, discounts, scholarships, waivers and authorised adjustments, all with reason,
actor, timestamp and audit trail. Historical fee structures preserved, never overwritten.

**Delivered:**

- A **financial ledger** as the single source of every balance. Charges, discounts, scholarship
  awards, waivers and adjustments are business records; none of them is summed to produce a
  balance. Each posts to `financial_entries` when it takes effect, and a balance is
  `SUM(DEBIT) − SUM(CREDIT)` and nothing else — which makes double-counting structurally
  impossible rather than a rule to remember (ADR-022).
- The ledger is **insert-only**. A voided charge or reversed relief posts an opposing entry
  linked to the original, so an account reads as a sequence of facts rather than a row that has
  been edited. There is no balance column anywhere to drift.
- Fee categories and fee structures, with applicability as a **filter rather than a hierarchy**:
  a structure matches when every field it names matches the student's own enrolment, including
  residency — the reason a day student is never charged for a bed. Two structures that would
  charge one category twice abort the run before anything is written (ADR-019).
- Charge generation with preview-then-apply, idempotent across re-runs by a duplicate key on the
  fee-structure line, which branches for termly and annual fees and exempts ad-hoc charges
  (ADR-020). A run applies in one transaction.
- A structure that has raised charges is **locked**; archiving withdraws it without touching the
  charges it raised, so a historical charge stays explainable after the price list changes.
- Discounts, scholarships (a named programme plus per-student, per-period awards), waivers and
  authorised adjustments, sharing one approval workflow: a Bursar requests, only a Finance
  Manager approves, and nobody approves their own request. Nothing reaches the ledger until
  approved; a percentage is taken against what a charge still carries, not its face value.
- Web client: fee setup, the charge-run screen with a mandatory preview, and a student financial
  account showing the balance, the charges, the relief and the ledger line by line.

**Test coverage:** 551 backend tests (54 new fee integration cases, 29 new balance unit cases)
and 60 frontend tests. The full local verification gate passes against PostgreSQL 17.

**Deferred with a reason:** payments are Phase 5 and post nothing yet, so `totalPaid` is
structurally present and always zero — the subtraction is in the formula and tested, so
introducing payments is a new entry source rather than a change to how money is counted.
Instalment schedules (OPEN-QUESTIONS #3) wait for the payment validation they exist to serve.

_Outcome:_ that prediction held. Phase 5 added `PAYMENT` as one more value of an existing enum
and one more member of an existing union; the balance formula, the posting rules and the
reversal mechanism were untouched, and `totalPaid` simply stopped being zero.

## ✅ Phase 5 — Payment system (online and manual)

Payment initiation with idempotency keys, transaction records, the provider port with one
adapter per channel (Bank of Kigali, Zigama CSS, Umwarimu SACCO, plus a sandbox adapter),
signature-verified webhooks with replay protection, status transitions, **the full manual
verification workflow** (claim → pending verification → bursar confirms against a statement →
ledger), proof-of-payment upload, bank/remittance statement import, and reconciliation.

**Delivered:**

- **One place where a payment becomes money.** A provider callback, a status query, a bursar
  pressing Verify and a reconciliation match all arrive at `finalisePayment`, which compares the
  confirmed amount and currency against the school's own record, then transitions the payment and
  posts its ledger CREDIT **in one transaction**. There is no state in which a payment reads as
  successful and no balance reflects it (ADR-023).
- **Three independent defences against a double credit**, because duplicate delivery is what
  payment providers normally do: a row lock, a conditional update from the finalisable statuses
  only, and a partial unique index — the last of which is not application behaviour, so a future
  code path that forgets to lock still cannot double-credit.
- **A mismatch is parked, not resolved.** A confirmation that disagrees with the claim credits
  neither figure; the payment moves to `REQUIRES_REVIEW` with both recorded, and a person
  decides. A success reported with no amount at all is held too, rather than assumed to be the
  amount requested.
- **A terminal status is final, and a repeat is not an error.** A late callback cannot resurrect a
  failed payment, and a duplicate one is recognised as a repeat and answered from the existing
  record instead of being processed again (ADR-024).
- **Webhooks verified against the raw bytes**, with the secret chosen by the path and the signed
  timestamp inside the digest, so a captured callback is stale rather than reusable. Every
  delivery is recorded before it is acted on, `(provider_key, event_id)` is unique, and every
  refusal is stored — one bad signature is a misconfiguration, a stream of them is somebody
  forging confirmations. The sender is told nothing either way (ADR-025).
- **The manual verification workflow**, which for every channel this school actually has is the
  only path there is: a claim recorded by a bursar or submitted by a parent, credited only when a
  named person confirms it against a statement, and never by the person who submitted it unless
  the school has deliberately relaxed that setting — with the blocked attempt audited either way.
- **Proof of payment** stored under an opaque server-generated key outside any web-servable path,
  typed by its own bytes rather than the browser's claim, served only through an authenticated
  endpoint that audits every download, and superseded rather than overwritten when replaced.
  Scan state is recorded as `SKIPPED` honestly, because no scanner is configured (ADR-027).
- **Bank statement import** for the shapes real exports arrive in — credits-only, separate
  credit and debit columns, a signed amount, thousands separators, accounting parentheses — with
  preview-then-commit, every unreadable row reported against the row number the bursar sees, and
  the same file refused a second time by its checksum.
- **Reconciliation that reports both sides**: statement lines nobody has attributed are money the
  school holds and cannot explain, and live payments with no statement line are claims the bank
  has no record of. The automatic pass attributes a line only when the payment's reference is
  quoted **and** the amount is exactly equal; everything else is a ranked suggestion carrying the
  reason it was offered, and two equally plausible candidates are ambiguity rather than a guess
  (ADR-026).
- **Undoing is compensating, never destructive.** A reversal (the money never arrived) and a
  refund (it arrived and was sent back) are separate permissions, neither held by a Bursar, and
  both keep the original payment and post an opposing ledger entry.
- Web client: the payments table with the verification queue as a bursar's default view, a
  payment screen where the statement amount is typed rather than pre-filled, the parent portal's
  pay-and-claim flow with slip upload, and the reconciliation worklist.

**Test coverage:** 181 tests are new in this phase — 153 backend (65 payment integration, 28
reconciliation integration, 60 unit across the status machine, file storage, the matcher and
the statement parser), 22 frontend, and 6 added to the configuration suite for the payment
settings. The full local verification gate (format, lint, typecheck, test, build) passes
against PostgreSQL 17. Four migrations: two for payments and two for reconciliation, each
pairing the tables with the constraints that hold their invariants. **CI has not yet run this
phase**, so nothing here should be described as shipped.

**Not built, and why:** no live provider adapter. Whether the three named Rwandan channels offer
a payment-notification API is still unconfirmed (OPEN-QUESTIONS #1 and #2), so none was invented:
they are registered as manual channels, `GET /payments/methods` says plainly which channels
cannot collect, and a sandbox simulator — refused outright in production — exercises the whole
provider path in development and CI. Adding a real adapter is a file plus a registry entry;
nothing in the payment domain, the ledger or the balance changes.

**Deferred with a reason:** a receipt is not issued on verification — receipt numbers, documents
and their history are Phase 6, and the sequence counter they need already exists. Instalment
schedules (OPEN-QUESTIONS #3) still wait on the school's policy. A `STUDENT` login cannot reach
its own records because nothing links a user to a student row, and inventing that rule inside the
module that guards financial data is exactly what this project does not do — it fails closed and
is recorded as OPEN-QUESTIONS #10 rather than left as a silent gap.

## ⬜ Phase 6 — Receipts and notifications

Unique receipt numbers, printable/downloadable receipts covering both verification methods,
receipt history, and pluggable notification channels (SMS, email, in-app) with asynchronous
delivery.

Two seams are already in place waiting for it: the `RECEIPT` identifier sequence and
`allocateReceiptNumber`, and `PasswordResetDelivery` — the port Phase 2 left behind so a reset
link has somewhere to go the moment a channel exists.

## ⬜ Phase 7 — Bursar and finance dashboard

Collection totals, outstanding balances, the payments table with server-side pagination and
filters, manual-versus-online distinction, the pending manual-verification queue, and the
reconciliation interface.

## ⬜ Phase 8 — Reporting

Daily, weekly, monthly, term and annual collection reports; outstanding fees; class, level and
programme reports; payment-method and payment-status reports; manual-versus-online split;
reconciliation and clearance reports; exports. Every figure computed from the database.

## ⬜ Phase 9 — Promotion and student lifecycle

End-of-year processing, batch promotion with confirmation, repetition, completion, transfer and
withdrawal with the configured proration rule. Promotion creates a new enrolment record and
never overwrites history.

## ⬜ Phase 10 — Financial clearance

Balance verification, clearance status and workflow, authorisation, history and reporting,
architected so library, laboratory, hostel and equipment clearance can be added later.

## ⬜ Phase 11 — Audit, security and compliance hardening

Security review of authorisation, authentication, financial operations, webhook security, rate
limiting and data access; insert-only, optionally hash-chained audit logs; and a Rwanda Law
N° 058/2021 data-protection review.

## ⬜ Phase 12 — Complete testing

Unit, integration, API, database, authorisation, payment (online and manual), end-to-end and
regression suites, all running in CI.

## ⬜ Phase 13 — Performance and reliability

Large student and payment datasets, reporting under load, concurrent requests exercising
optimistic locking, query plans, pagination. Optimise only where evidence shows a problem.

## ⬜ Phase 14 — Production preparation

Production configuration, migration strategy, backups **with periodic restore testing**,
logging, monitoring, error tracking, deployment documentation and recovery procedures.

## ⬜ Phase 15 — Final system audit

A full audit against every requirement, including both payment paths, balances, receipts,
reports, promotion, clearance, audit logging, notifications, tests green in CI, and
documentation that matches the implementation.

---

## Cross-cutting invariants

Maintained from Phase 1 onward and asserted by tests, not merely intended:

- A verified payment corresponds to a valid student.
- A payment is never recorded twice.
- A receipt corresponds to a valid payment.
- A balance is always `charges − verified payments ± authorised adjustments`, derived and
  never manually typed.
- A manual claim never affects the ledger until explicitly verified.
- Historical enrolment and fee structures are never overwritten.
- A payment reversal preserves the original transaction history.
- Audit logs are insert-only.
- Unauthorised users cannot read or modify financial records, across schools included.
