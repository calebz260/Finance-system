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

## ⬜ Phase 4 — Fee management

Fee structures scoped by **academic year + term + level/class + programme**, fee items,
student charges, discounts, scholarships, waivers and authorised adjustments, all with reason,
actor, timestamp and audit trail. Historical fee structures preserved, never overwritten.

## ⬜ Phase 5 — Payment system (online and manual)

Payment initiation with idempotency keys, transaction records, the provider port with one
adapter per channel (Bank of Kigali, Zigama CSS, Umwarimu SACCO, plus a sandbox adapter),
signature-verified webhooks with replay protection, status transitions, **the full manual
verification workflow** (claim → pending verification → bursar confirms against a statement →
ledger), proof-of-payment upload, bank/remittance statement import, and reconciliation.

## ⬜ Phase 6 — Receipts and notifications

Unique receipt numbers, printable/downloadable receipts covering both verification methods,
receipt history, and pluggable notification channels (SMS, email, in-app) with asynchronous
delivery.

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
