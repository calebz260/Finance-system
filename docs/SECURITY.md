# Security

This system holds the personal and financial data of minors and moves real money. This
document records what is enforced **today** and what each later phase adds — so the gap
between the two is always visible rather than assumed closed.

## In place now (Phases 0–2)

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

### Authentication (Phase 2)

- **Argon2id** password hashing at the OWASP parameters, with the cost recorded in the hash so
  raising it later does not lock anyone out; hashes below the current policy are upgraded on
  the owner&#39;s next sign-in.
- **A password policy applied where a password is set, never where one is presented.** A length
  floor, a common-password blocklist, and a refusal of anything built from the account&#39;s own
  name, email or the school&#39;s. Deliberately no composition rules: they push people towards
  `Password1!`, which is among the first guesses any attacker makes.
- **An unknown email and a wrong password are indistinguishable** — same code, same message,
  and the unknown-user path verifies against a decoy hash so the response time does not reveal
  which it was. The same applies to a password-reset request.
- **Per-account lockout that a failed second factor also counts towards.** Six digits is a
  million guesses; without this, MFA would be the one credential an attacker could try without
  limit. The counter lives in the database, so a restart does not clear it, and it is cleared
  only on a _completed_ sign-in — not merely on a correct password.
- **TOTP MFA, mandatory for Bursar, Finance Manager, School Administrator and Super
  Administrator.** A correct password for such a role yields an intermediate token with a
  different audience, which the authentication middleware rejects, so there is no session until
  the second factor is proved. An account holding such a role that has never enrolled is routed
  into enrolment rather than admitted on one factor.
- **MFA secrets are AES-256-GCM encrypted at rest** under a key held outside the database, and
  the accepted step counter is stored so an observed code cannot be replayed within its window.
- **Recovery codes** are single-use, 100 bits of entropy, stored only as SHA-256 hashes, and
  their use is audited.

### Sessions (Phase 2)

- **Sessions are server-side, not implied by a self-contained token.** Every authenticated
  request re-reads the session, the account status and the current permissions, so suspending an
  account or revoking a role takes effect on the next request rather than at token expiry.
- **The access token is short-lived and travels in a header**, held in browser memory — never in
  `localStorage`, where an injected script could read it. It carries no permissions.
- **The refresh token is opaque, stored only as a hash, and lives in an httpOnly cookie** scoped
  to `/api/v1/auth`, so JavaScript cannot read it and it is not attached to ordinary API calls.
  `SameSite=None` is rejected outright in production.
- **Refresh tokens rotate, and reuse collapses the session.** A consumed token presented again
  is either a client replay or a theft, and the request cannot tell which — so the session is
  revoked and the event is audited, turning a silent compromise into a visible one.
- A password change ends every _other_ session; a password reset, a suspension and an MFA
  change end them all.

### Authorisation (Phase 2)

- **Every decision is made on the backend from permissions loaded out of the database for that
  request.** Nothing the client sends contributes: not a role in a header, not a claim in the
  token. The web client uses the same permission list only to decide what to render.
- **Tenant scope is derived from the user, not from the token**, so a tampered or merely stale
  claim cannot widen access. A record in another school reads as `404`, because `403` would
  confirm the id exists.
- **Separation of duties on account administration**: nobody edits the roles on their own
  account, nobody grants a role above their own rank, nobody changes their own account status,
  and the last active Super Administrator cannot be removed. The self-assignment rule is the
  load-bearing one — ranks order privilege but do not nest permissions, so a School
  Administrator (rank 80) granting themselves Finance Manager (rank 70) would be a genuine
  escalation.
- **Role changes require a second factor**, whatever the role.
- **Denials are audited.** One `403` is usually a misconfigured account; a pattern of them is
  someone probing, and that distinction only exists if the attempts are recorded.

### Financial controls (Phase 4)

The money-moving endpoints are governed by the separation of duties already encoded in the role
matrix, not by new rules invented for this phase:

- **Setting a price is not charging it.** `fee_structure.manage` configures categories and
  structures; `charge.create` raises obligations. A School Administrator holds the first and not
  the second; a Bursar holds the second and not the first.
- **Nobody writes off what they collect.** A Bursar may request a discount, scholarship, waiver
  or adjustment; only a Finance Manager may approve one, and only a Finance Manager may void a
  charge. The service additionally refuses to let anyone approve their own request, regardless
  of permissions — a Finance Manager holds both and would otherwise be a single point of
  authorisation for money leaving the ledger.
- **Every financial write requires a satisfied second factor.** All four roles that reach these
  routes are MFA-required, so `requireMfaSatisfied` is not extra friction: it is the guarantee
  that a stolen password alone cannot move money.
- **Cross-tenant reads answer 404, not 403**, including balances — otherwise a balance endpoint
  becomes a way to confirm that a student id exists in another school.

Amounts arrive as **strings** and are rejected if sent as JSON numbers, which have already lost
precision by the time a validator sees them. Percentages are bounded at the database. Every
monetary column carries a check constraint, and the ledger's are the strictest: a positive
amount, exactly one source reference matching its source, and no self-reversal.

The ledger is insert-only by construction — there is no update or delete path in the application
— and Phase 11 revokes UPDATE and DELETE on `financial_entries` and `audit_logs` from the
application role, so the code cannot regain one.

**Not yet hardened:** the hash chain on `audit_logs` and the database-level privilege revocation
are Phase 11. Until then insert-only is an application-level property, enforced by there being
no other code path, rather than by the database refusing.

### File upload, as it stands today (Phase 3)

The bulk student import is the only endpoint that accepts a file. Until Phase 5 designs file
handling properly, it is deliberately narrow:

- the upload is held **in memory only** and discarded when the request ends, so nothing is
  written to a path that has not yet been designed;
- one file per request, capped at 5 MB, and the extension must be `.csv` or `.xlsx` — the
  browser-supplied `Content-Type` is not trusted, because Excel files arrive variously as
  `application/octet-stream` or as nothing at all;
- committing an import requires `student.import` **and** a satisfied second factor, since one
  upload can create a thousand students and their guardians;
- the preview needs only `student.read`: it writes nothing.

Malware scanning, storage outside any web-servable path and content validation for
proof-of-payment documents arrive with Phase 5, which owns uploads.

## Arriving in later phases

| Control                                                                                                         | Phase    |
| --------------------------------------------------------------------------------------------------------------- | -------- |
| Audit logging of financial operations and configuration changes (login, roles and account changes are in place) | 2 onward |
| Emailed password-reset links (the token, the expiry and the single-use rule already exist)                      | 6        |
| Object-level authorisation (a parent may read only their own children's records)                                | 3        |
| Idempotency keys, webhook signature verification, replay protection, duplicate-payment constraints              | 5        |
| File-upload validation, storage outside any web-servable path, malware scanning                                 | 5        |
| Separation of duties on manual payment verification                                                             | 5        |
| Insert-only, optionally hash-chained audit logs                                                                 | 11       |
| Rwanda Law N° 058/2021 data-protection review; retention policy per record type                                 | 11       |
| Restore-tested backups, monitoring, error tracking, secret rotation                                             | 14       |

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
