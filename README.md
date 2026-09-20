# School Finance System

A centralised financial management system for a Rwandan secondary school: student fee
structures, student financial accounts, payments (both provider-processed and manually
verified bank/SACCO payments), reconciliation, receipts, financial reporting, clearance and
audit.

Its purpose is to replace the school's manual fee-slip verification process, so the
manual/offline payment path is a first-class workflow rather than an exception path.

> **Build status: Phases 0–4 complete** — project foundation, the core domain schema,
> authentication and authorisation, student and academic management including the bulk student
> import, and fee management with a financial ledger. Payments, receipts and reporting land in
> Phases 5–15 — see [docs/ROADMAP.md](docs/ROADMAP.md) for exactly what exists today and
> what does not. Nothing in this repository pretends to be finished before it is.

---

## Quick start

**Prerequisites:** Node.js 22+, npm 10+, Docker (for PostgreSQL), Git.

```bash
# 1. Install dependencies for all workspaces
npm install

# 2. Create the backend environment file
cp backend/.env.example backend/.env

# 3. Start PostgreSQL 17 (listens on localhost:5544, not 5432 — see note below)
npm run db:up

# 4. Generate the Prisma client and apply migrations
npm run db:migrate --workspace @sfs/backend

# 5. Seed the role catalogue and a realistic school
npm run db:seed --workspace @sfs/backend

# 6. Run the API (http://localhost:4000) and the web client (http://localhost:5173)
npm run dev --workspace @sfs/backend
npm run dev --workspace @sfs/frontend
```

Then open <http://localhost:5173> and sign in with a seeded account — `npm run db:seed` prints
the list and the shared development password. Every seeded account must replace that password
on first sign-in.

Two things to expect on a first run. `JWT_ACCESS_SECRET` and `MFA_ENCRYPTION_KEY` have **no
defaults** — the template ships deliberately invalid values, so the API refuses to start until
you generate real ones (the commands are in `backend/.env.example`). And the seeded Bursar,
Finance Manager, School Administrator and Super Administrator accounts require two-factor
authentication: signing in as one walks you through enrolment with an authenticator app, which
is the intended behaviour rather than a misconfiguration. A Parent or Student account signs in
with a password alone.

Until Phase 6 adds a notification channel, a password-reset link is not emailed. In
development the token is written to the API log; in any other environment the attempt is
logged as an error and nothing is sent. See
[ADR-013](docs/DECISIONS.md#adr-013-a-password-reset-link-goes-through-a-delivery-port-never-into-a-response-or-a-log).

> **Port note:** the PostgreSQL container publishes **5544**, because developer machines
> commonly already run something on 5432. Override with `POSTGRES_PORT` in your shell or a
> root `.env` if 5544 also clashes, and update `DATABASE_URL` to match.

### Verify everything

```bash
npm run verify   # format check -> lint -> typecheck -> tests -> build
```

The same gate runs in CI on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Integration tests need
PostgreSQL running.

---

## Repository layout

```
.
├── backend/              Express 5 + TypeScript REST API
│   ├── prisma/           Schema, migrations, seed
│   ├── prisma.config.ts  Prisma 7 CLI configuration (connection URL lives here)
│   └── src/
│       ├── config/       Environment parsing and validation (fail-fast)
│       ├── lib/          Errors, logging, HTTP helpers, Prisma client, request context
│       ├── middleware/   Request context, logging, validation, rate limits, errors
│       ├── modules/      One folder per domain module: controller -> service -> repository
│       ├── routes/       Versioned router composition (/api/v1)
│       └── generated/    Prisma client output (generated, not committed)
├── frontend/             React 19 + TypeScript + Tailwind 4 web client
│   └── src/
│       ├── components/   Reusable UI and layout
│       ├── hooks/        Data-loading hooks
│       ├── lib/          API client, formatting, class-name helper
│       └── pages/        One folder-level file per screen
├── shared/               Types, constants and the Money value object used by both sides
├── infra/                Local infrastructure helpers (database bootstrap SQL)
├── docs/                 Architecture, environment, database, security, testing, decisions
└── .github/workflows/    CI pipeline
```

## Technology

| Concern    | Choice                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| API        | Node.js 22, Express 5, TypeScript (layered: controller → service → repository)                                |
| Database   | PostgreSQL 17 via Prisma 7 with the `pg` driver adapter                                                       |
| Money      | `Decimal`/`NUMERIC(14,2)` end to end, never floating point — see [`shared/src/money.ts`](shared/src/money.ts) |
| Web client | React 19, React Router 7, Tailwind CSS 4, Vite 8                                                              |
| Validation | Zod 4, on every request boundary                                                                              |
| Tests      | Vitest 5 (+ Supertest, Testing Library); unit and integration projects                                        |
| Quality    | ESLint 10 with type-aware rules, Prettier 3, GitHub Actions                                                   |

## Root scripts

| Command                     | Purpose                                             |
| --------------------------- | --------------------------------------------------- |
| `npm run verify`            | The full gate: format, lint, typecheck, test, build |
| `npm run dev`               | Backend and frontend dev servers                    |
| `npm run lint` / `lint:fix` | ESLint across all workspaces                        |
| `npm run typecheck`         | TypeScript, no emit, all workspaces                 |
| `npm test`                  | All test suites                                     |
| `npm run build`             | Build shared, backend and frontend                  |
| `npm run db:up` / `db:down` | Start/stop the PostgreSQL container                 |
| `npm run db:migrate`        | Apply migrations in development                     |
| `npm run db:seed`           | Load development seed data                          |

## Documentation

| Document                                         | Contents                                                |
| ------------------------------------------------ | ------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)     | Layers, request lifecycle, module anatomy, conventions  |
| [docs/DATABASE.md](docs/DATABASE.md)             | Schema conventions, money and time handling, migrations |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)       | Every environment variable and what it affects          |
| [docs/SECURITY.md](docs/SECURITY.md)             | Controls in place, and what each later phase adds       |
| [docs/TESTING.md](docs/TESTING.md)               | Test layers, how to run them, what must be covered      |
| [docs/DECISIONS.md](docs/DECISIONS.md)           | Architectural decisions and their reasoning             |
| [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) | Decisions that need the school's confirmation           |
| [docs/ROADMAP.md](docs/ROADMAP.md)               | Phase-by-phase plan and current status                  |

## Data protection

This system stores the personal and financial data of minors and is built to comply with
Rwanda's Law N° 058/2021 on the protection of personal data and privacy. Financial records
and audit entries are never deleted; identifying personal data is subject to retention
periods that still need to be confirmed with the school and are tracked in
[docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).

## Licence

Proprietary. All rights reserved.
