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

## ⬜ Phase 1 — Database and core domain

Schools, users, roles, permissions, students, parents/guardians, student–parent relationships,
academic years, **terms**, levels, classes, programmes/trades, departments, enrolments — with
`school_id` scoping from the first migration. Migrations, realistic seed data, relationship
tests.

Conventions already fixed: `Decimal(14,2)` money, `timestamptz` UTC, UUID keys, snake_case
table names, `version` columns for optimistic locking on co-edited rows.

## ⬜ Phase 2 — Authentication and authorisation

Login, logout, password hashing (Argon2id), password reset, session/token management, **TOTP
MFA for Bursar, Finance Manager, School Administrator and Super Administrator**, RBAC with
backend enforcement, protected routes, account status, brute-force protection. Every role
tested for what it may and may not do.

## ⬜ Phase 3 — Student and academic management

Student registration and Student ID allocation, student profile, parent linking, classes,
programmes, levels, academic years and terms, enrolment history, student status, and the
**bulk CSV/Excel import** for the school's existing ~1,000+ students with a
validation-and-preview step and row-level error reporting.

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
