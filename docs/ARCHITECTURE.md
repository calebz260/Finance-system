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

Two modules add files to that anatomy rather than departing from it, and both do so for the
same reason: one service file would have been the largest and least reviewable thing in the
repository, and the extra files each hold a rule that is worth reading on its own.

| File                                 | Why it is separate                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `payments/payment.status.ts`         | The status machine, pure and dependency-free. It decides whether a payment may become successful, so it is testable without I/O. |
| `payments/payment.finalize.ts`       | The one place a payment becomes money. Every caller arrives here with the same shape, so the checks cannot differ by who asked.  |
| `payments/payment.access.ts`         | Who may see, and pay for, which student. One file, so "is this your child?" has exactly one answer.                              |
| `payments/providers/`                | The port and its adapters. No service imports an adapter.                                                                        |
| `payments/content-scanner.ts`        | A port for scanning uploads, with the honest no-op adapter that records `SKIPPED`.                                               |
| `reconciliation/statement.parser.ts` | Reading a bank's export, which has no standard. Pure, and tested against the shapes real exports arrive in.                      |
| `reconciliation/matching.service.ts` | Which payment a statement line belongs to. Pure, and the most consequential guesswork in the system — so it does not guess.      |

### Where authentication sits

`authenticate` runs before any protected route and establishes `req.principal`: the caller&#39;s
identity, the permissions in force **right now**, and the tenant scope. It is loaded from the
database on every request rather than read out of the token, which is what makes a suspension
or a revoked role take effect immediately instead of at token expiry. `requirePermission`,
`requireRole`, `requireMfaSatisfied` and `requireUsablePassword` then decide, and a denial is
audited.

The auth module keeps the standard anatomy with two additions: `token.service.ts` and
`session.service.ts` are services in the ordinary sense, while `principal.ts` is the one place
a database row becomes the request&#39;s notion of "who is calling". `password-delivery.ts` is a
port, for the same reason `DatabaseProbe` is: the channel that will carry a reset link does
not exist until Phase 6, and the flow should not have to be rewritten when it does.

### Ports and adapters where it earns its keep

`HealthService` depends on a `DatabaseProbe` interface, not on Prisma. That is what lets the
integration suite assert the HTTP contract without a database, and it is the same seam the
payment providers use.

From Phase 5 the payment domain depends on a `PaymentProviderAdapter` port
(`modules/payments/providers/provider.port.ts`) and never on an adapter. Three rules the port
imposes on every adapter, present and future, and each of them is a decision about money rather
than about code structure:

- **An adapter never decides that money moved.** It reports what the provider said; whether that
  is enough to credit a student is decided by `payment.finalize.ts` against the school's own
  record. A confirmation is evidence, not authority.
- **An adapter never throws for an ordinary provider outcome.** A decline, a timeout and an
  unreachable provider are all results, and `UNKNOWN` most of all — a request that timed out may
  still have taken the payer's money, and treating that as a failure is how a family is told a
  payment failed and then charged for it anyway.
- **An adapter returns no secrets.** Tokens, signatures and credentials never leave it.

What is registered today is one **sandbox simulator**, which makes the whole provider path
exercisable without a bank, and three named Rwandan channels registered as _manual_ channels
with no adapter — because whether they offer a payment-notification API is still unconfirmed
(OPEN-QUESTIONS #1 and #2). `GET /payments/methods` reports that honestly, so no parent is shown
a channel that cannot collect.

Two further ports arrived with the same phase: `ContentScanner` for uploaded proof of payment
(the port exists, no scanner is configured, and the recorded state says `SKIPPED` rather than
pretending), and `PasswordResetDelivery` from Phase 2, still waiting for Phase 6.

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
  ├─ /api/v1/payment-webhooks  BEFORE the JSON parser: express.raw, so a signature can be
  │                            checked against the bytes the provider actually sent
  ├─ express.json           after requestContext, so parse failures still have an id
  ├─ cookieParser
  │
  ├─ /healthz, /readyz      unversioned infrastructure probes
  ├─ /api/v1/...            versioned application API
  │     └─ authenticate → requirePermission → validate(schemas)
  │          → controller → service → repository → PostgreSQL
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

Phase 5 added a third, for the same kind of reason: the **webhook route is mounted before
`express.json`**. Once the JSON parser has run, the bytes the provider signed are gone, and a
signature verified against `JSON.stringify(req.body)` is not verified against anything (ADR-025).
It still sits after the request context, the access log and the rate limiter, so a callback is
logged, correlated and throttled like every other request.

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
- **`Idempotency-Key` is honoured on payment initiation and manual claims.** It is a header
  rather than a field because it describes the request, not the payment, and a client retrying
  must be able to repeat the body byte for byte. The key is stored with a fingerprint of the
  request it was first used for: a genuine retry replays the original payment and answers `200`
  with `replayed: true`, while the same key sent with a different student or amount is refused
  with `IDEMPOTENCY_KEY_REUSED` rather than answered with somebody else's payment.
- **A write that a person decides carries `expectedVersion`.** Verifying a payment, cancelling
  one, reversing one and matching a statement line all take the version the screen was showing,
  and a stale value is refused with `RECORD_MODIFIED`. It is not what prevents a double credit —
  a row lock and a unique index do that — it is what stops a bursar acting on what a payment
  used to say.

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
- `auth/AuthProvider.tsx` with `lib/auth-token.ts` — the session. The access token is held in
  memory, never in web storage, and is renewed silently through the httpOnly refresh cookie
  when a request comes back expired. Concurrent renewals collapse onto one request, because
  presenting a consumed refresh token twice is what the server treats as theft.
- `components/auth/RequireAuth.tsx` — the route guard. It decides what to _render_; the server
  decides what is allowed, and re-reads permissions from the database to do it. `permissions`
  requires all of them, `anyPermission` requires one — the second exists for the screens a
  bursar and a parent both reach, where requiring both would hide the page from each of them for
  want of the other's permission.
- `lib/upload.ts` — the one place a multipart request is made. Separate from `api-client`
  because the browser must set the `Content-Type` boundary itself, and it keeps everything else
  the client guarantees: the bearer token, the shared error envelope, the request id, and one
  silent token renewal.
- `lib/api-client.ts`'s `downloadBlob` — for proof of payment, which is fetched with credentials
  and handed to the browser as a blob rather than linked to. An `<a href>` would send no
  credentials and, if it did, would produce a URL somebody could forward to a person with no
  right to the document.

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

## How money moves, end to end

Worth stating in one place, because it is the path every later phase reports on:

```
a charge is raised            → financial_entries: DEBIT  (source CHARGE)
relief is approved            → financial_entries: CREDIT (source DISCOUNT | SCHOLARSHIP | WAIVER | ADJUSTMENT)
a payment is verified         → financial_entries: CREDIT (source PAYMENT)
a payment is reversed/refunded→ financial_entries: DEBIT  (source PAYMENT, reversal_of_entry_id set)

balance = SUM(DEBIT) − SUM(CREDIT)
```

Nothing else moves a balance, and no other table is summed to produce one. A payment is
therefore not a special case in the accounting: it is one more entry source (ADR-022, ADR-023).

The two ways a payment becomes verified are deliberately the only two, and both end in the same
function:

```
provider callback → verify signature → record event → resolve attempt ─┐
bursar confirms against a statement ───────────────────────────────────┼→ finalisePayment
statement line matched with "confirm" ─────────────────────────────────┘   (locks, compares the
                                                                            amount, transitions,
                                                                            posts the CREDIT,
                                                                            audits — atomically)
```

## What is not built yet

Receipts and notifications, dashboards, reporting, promotion and clearance arrive in later
phases. The foundation they need — typed config, error hierarchy, request context, audit-ready
logging, validation middleware, money handling, the domain schema, authentication,
backend-enforced authorisation, the ledger, the payment path, the test harness and CI — is in
place, so none of them requires rebuilding it. See [ROADMAP.md](ROADMAP.md).
