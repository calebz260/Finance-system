# Architecture

## Shape of the system

Three workspaces in one npm-workspaces monorepo:

```
┌──────────────┐        HTTPS/JSON        ┌──────────────┐     SQL      ┌────────────┐
│  frontend    │ ───────────────────────► │  backend     │ ───────────► │ PostgreSQL │
│  React SPA   │ ◄─────────────────────── │  Express API │ ◄─────────── │     17     │
└──────────────┘   { data } / { error }   └──────────────┘   Prisma 7   └────────────┘
        │                                        │
        └──────────────► shared ◄────────────────┘
                 types, constants, Money
```

`shared` is the reason a response shape cannot drift between the server that produces it and
the screen that renders it: both import the same types, so a mismatch is a compile error
rather than a production surprise.

## Backend layers

Each module is a folder under `backend/src/modules/<module>/` with the same anatomy:

| File                     | Responsibility                                                 | May depend on              |
| ------------------------ | -------------------------------------------------------------- | -------------------------- |
| `<module>.routes.ts`     | URL shape, middleware wiring, dependency construction          | controller, middleware     |
| `<module>.controller.ts` | HTTP ↔ domain translation only; no business rules              | service, `lib/http`        |
| `<module>.service.ts`    | Business rules, invariants, transactions, authorisation checks | repository, other services |
| `<module>.repository.ts` | Data access; the only place Prisma is used                     | `lib/prisma`               |
| `<module>.schema.ts`     | Zod schemas for request validation and shared DTO types        | `shared`                   |

Rules that keep the layering real rather than decorative:

- **Controllers hold no logic.** If a controller computes something, it belongs in a service.
- **Services never touch `req`/`res`.** They take plain arguments and return plain values or
  throw an `AppError`. That is what makes them testable without HTTP.
- **Only repositories import Prisma.** A service that reaches for the ORM directly bypasses
  the tenant scoping and the optimistic-locking conventions.
- **No monetary arithmetic outside `Money`.** Charges, payments, adjustments and balances all
  flow through `shared/src/money.ts`.

Health is the first module and deliberately follows the full pattern even though it is
trivial, so the shape is established before the complicated modules arrive.

### Ports and adapters where it earns its keep

`HealthService` depends on a `DatabaseProbe` interface, not on Prisma. That is what lets the
integration suite assert the HTTP contract without a database, and it is the same seam the
payment providers will use: the payment service will depend on a `PaymentProvider` port, with
one adapter per channel (Bank of Kigali, Zigama CSS, Umwarimu SACCO, plus a sandbox/mock),
and the core payment and ledger logic will not know which channel was used.

## Request lifecycle

```
request
  │
  ├─ helmet                 security headers
  ├─ cors                   origin allowlist (exact matches only)
  ├─ requestContext         assigns request id; opens AsyncLocalStorage context
  ├─ requestLogger          one access-log line per request, correlated by id
  ├─ globalRateLimiter      before any body is parsed
  ├─ compression
  ├─ express.json           after requestContext, so parse failures still have an id
  ├─ cookieParser
  │
  ├─ /healthz, /readyz      unversioned infrastructure probes
  ├─ /api/v1/...            versioned application API
  │     └─ validate(schemas) → controller → service → repository → PostgreSQL
  │
  ├─ notFoundHandler        404 in the standard error envelope
  └─ errorHandler           the single place an error becomes a response
```

The middleware order is load-bearing, not incidental. Two orderings were corrected during
Phase 0 because running the server exposed the consequences:

- Body parsing sits **after** `requestContext`, otherwise a malformed-JSON rejection has no
  request id — precisely the failure a user needs a reference for.
- Rate limiting sits **before** body parsing, so an abusive client cannot make the server
  parse megabytes before being turned away.

Both are covered by regression tests in `backend/tests/integration/app.test.ts`.

## API conventions

Success:

```json
{ "data": { "…": "…" }, "meta": { "…": "optional" } }
```

Paginated list:

```json
{
  "data": [ … ],
  "meta": {
    "page": 1, "pageSize": 25, "totalItems": 1040,
    "totalPages": 42, "hasNextPage": true, "hasPreviousPage": false
  }
}
```

Error:

```json
{
  "error": {
    "code": "RECORD_MODIFIED",
    "message": "This record was changed by someone else…",
    "fieldErrors": [{ "path": "body.amount", "message": "…" }],
    "details": { "minimumAmount": "1000.00" },
    "requestId": "b78d6d9e-…",
    "timestamp": "2026-09-18T08:54:32.530Z"
  }
}
```

- `code` is from the shared `ErrorCode` union. The web client branches on it, never on
  message text.
- `requestId` appears in the response body, the `X-Request-Id` header and every matching log
  line.
- Money crosses the boundary as a **string** (`"125000.00"`), never a JSON number. A JSON
  number would be parsed as an IEEE-754 double and could lose precision on the way.
- Lists are paginated server-side. A payments table must never stream the whole table into a
  browser.

## Error handling

`AppError` subclasses carry an HTTP status, an `ErrorCode`, a user-safe message and an
`isOperational` flag. The error middleware then:

- returns operational errors as they are (a domain refusal such as "amount below minimum" is
  safe to show);
- reports anything non-operational as a generic 500, logging the real error in full;
- translates Zod, body-parser and Prisma failures into the correct domain code instead of
  letting them surface as 500s — for example Prisma `P2002` → `409 DUPLICATE_RESOURCE`,
  `P2034` (write conflict) → `409 RECORD_MODIFIED`, which the client may retry.

Stack traces, SQL and connection strings never reach a client.

## Logging

Structured JSON on stdout in production, pretty-printed in development. Every record carries
the service, version, environment and request id.

Two safeguards matter more than the format:

- a **redaction list** covering authorisation headers, cookies, passwords, tokens, MFA
  secrets, webhook signatures and API keys;
- a **whitelisting error serialiser** (`serialiseError`). Pino's default copies every own
  property of an error, and body-parser attaches the raw request body to a JSON parse
  error — which for this system could be a payment payload. Only type, message, stack,
  string `code`, numeric status and a bounded `cause` chain are kept.

Access logs record the matched path with the query string stripped, because query strings
here carry student ids and filter values.

## Frontend structure

- `lib/api-client.ts` — the only place `fetch` is called. It unwraps the envelope, turns
  every failure into one `ApiError` type with a machine-readable `code`, surfaces the request
  id, and sends credentials so the Phase 2 refresh cookie works unchanged.
- `hooks/use-async-resource.ts` — data loading with abort-on-unmount (a late response can
  never overwrite fresher state) and refresh that keeps previous data visible.
- `components/ui/DataState.tsx` — the single place loading, error, empty and success are
  rendered, so no screen can ship missing one of them.
- `components/ErrorBoundary.tsx` — a render crash shows a recoverable message instead of a
  blank page, and never renders the error text, which can contain props holding student data.
- `lib/format.ts` — the only place timestamps are converted from stored UTC to Africa/Kigali,
  and the only place money strings are formatted. It formats; it never recomputes.

## Configuration

`backend/src/config/env.ts` parses and validates the environment once, at startup, and throws
a `ConfigurationError` listing every problem at once. Nothing else in the backend reads
`process.env`. Production-only assertions are enforced there too — a wildcard or non-HTTPS
CORS origin is rejected outright rather than warned about.

## Multi-tenancy

Every core table will carry a `school_id`, and scoping will be applied in the repository
layer through shared helpers rather than trusted to callers (Section 5 of the specification).
The column and the scoping layer cost almost nothing now and are expensive to retrofit once
real financial data exists. See [DECISIONS.md](DECISIONS.md#adr-002-multi-school-from-day-one).

## What Phase 0 deliberately does not include

Authentication, authorisation, the domain schema, payments and reporting all arrive in later
phases. The foundation they need — typed config, error hierarchy, request context, audit-ready
logging, validation middleware, money handling, the test harness and CI — is in place, so
none of them requires rebuilding it. See [ROADMAP.md](ROADMAP.md).
