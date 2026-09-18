# Security

This system holds the personal and financial data of minors and moves real money. This
document records what is enforced **today** and what each later phase adds — so the gap
between the two is always visible rather than assumed closed.

## In place now (Phase 0)

### Transport and headers

- Helmet security headers on every response; `Referrer-Policy: no-referrer`.
- The framework is not advertised (`x-powered-by` disabled).
- CORS uses an exact-match origin allowlist. In production, a wildcard origin and any
  non-HTTPS origin other than localhost are rejected at startup, not warned about.
- `credentials: true` with an explicit allowlist, ready for the Phase 2 refresh cookie.

### Request handling

- `trust proxy` is set from an **explicit hop count**, never `true`. Trusting any
  `X-Forwarded-For` would let a client forge its IP, evading rate limits and corrupting the IP
  recorded in audit logs.
- Global per-IP rate limiting, applied **before** body parsing so an abusive client cannot
  make the server parse megabytes before being turned away. Tighter limiters for auth,
  payment and webhook routes are written and applied when those routes exist.
- JSON body size limit (256 KB default); oversized bodies are rejected as `413`.
- A client-supplied `X-Request-Id` is honoured only when it matches a safe opaque pattern,
  which prevents log forging through injected control characters.
- All input is validated with Zod at the request boundary. Parsed output goes on `req.valid`;
  a route that forgets the middleware fails immediately rather than passing `undefined` into a
  service.

### Error and log hygiene

- Errors never expose stack traces, SQL, connection strings or secrets. Non-operational
  errors return a generic message plus a request id.
- Database probe failures report a fixed message, because the driver's message can contain the
  host, user and password from the connection string. Asserted by a test.
- The logger redacts authorisation headers, cookies, passwords, tokens, MFA secrets, webhook
  signatures and API keys.
- A **whitelisting** error serialiser keeps only type, message, stack, string `code`, numeric
  status and a bounded `cause` chain. Pino's default copies every own property of an error, and
  body-parser attaches the raw request body to a JSON parse error — which here could be a
  payment payload. Asserted by a test.
- Access logs record the matched path with the query string stripped, since query strings here
  carry student ids and filter values.
- Prisma query logging is off; query text plus parameters would place student and payment data
  in the logs.

### Data handling

- Money is `NUMERIC(14,2)`/`Decimal` end to end, never floating point, and never computed in
  the browser.
- Timestamps are stored in UTC and converted for display in exactly one place.
- No secrets in the repository. `.gitignore` covers `.env*` (except the template), keys,
  certificates, uploads and the generated Prisma client.
- `VITE_`-prefixed variables are compiled into the public bundle; the environment
  documentation states plainly that no secret may ever carry that prefix.

### Supply chain and process

- Locked dependency versions (`package-lock.json`), `npm ci` in CI.
- Type-aware linting, including `no-floating-promises` — an un-awaited financial write is a
  security-relevant bug, not just a correctness one.
- CI gates merges on lint, typecheck and the full test suite.

## Arriving in later phases

| Control                                                                                            | Phase    |
| -------------------------------------------------------------------------------------------------- | -------- |
| Argon2id password hashing, password policy, brute-force lockout, password reset                    | 2        |
| TOTP MFA for Bursar, Finance Manager, School Administrator, Super Administrator                    | 2        |
| Backend-enforced RBAC; `school_id` scope enforced in repositories                                  | 2        |
| Audit logging of login, financial operations, role and configuration changes                       | 2 onward |
| Object-level authorisation (a parent may read only their own children's records)                   | 3        |
| Idempotency keys, webhook signature verification, replay protection, duplicate-payment constraints | 5        |
| File-upload validation, storage outside any web-servable path, malware scanning                    | 5        |
| Separation of duties on manual payment verification                                                | 5        |
| Insert-only, optionally hash-chained audit logs                                                    | 11       |
| Rwanda Law N° 058/2021 data-protection review; retention policy per record type                    | 11       |
| Restore-tested backups, monitoring, error tracking, secret rotation                                | 14       |

## Threats explicitly designed against

| Threat                         | Mitigation                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| SQL injection                  | Parameterised queries via Prisma; no string-built SQL                                                                        |
| Broken access control / IDOR   | Backend-enforced authorisation on every route; `school_id` scoping in repositories; never trusting role data from the client |
| Duplicate payment processing   | Client idempotency keys plus a unique database constraint on the provider transaction reference                              |
| Webhook spoofing and replay    | Signature verification, reference and amount validation, replay windows, rate limiting                                       |
| Fake payment confirmation      | A frontend "success" is never proof; only a server-verified payment touches the ledger                                       |
| Lost update on a shared record | Optimistic locking via a `version` column; the losing write is rejected with `RECORD_MODIFIED`                               |
| Brute force                    | Strict auth rate limiting plus account lockout                                                                               |
| Sensitive data in logs         | Redaction list and whitelisting error serialiser, both test-asserted                                                         |
| Privilege escalation           | Role and permission changes are audited; sensitive financial operations require an explicit permission                       |
| Insecure upload                | Type and size validation, storage outside any executable path, content never interpreted                                     |

## Reporting a vulnerability

Report suspected vulnerabilities to the school's IT administrator and the project maintainer
directly. Do not open a public issue.
