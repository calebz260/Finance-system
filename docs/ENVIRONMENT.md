# Environment variables

All backend configuration is parsed and validated once, at startup, by
`backend/src/config/env.ts`. A misconfigured deployment fails immediately with every problem
listed, rather than surfacing later as a mysterious runtime error. Nothing else in the
backend reads `process.env`.

Copy the template and edit it:

```bash
cp backend/.env.example backend/.env
```

`backend/.env` is git-ignored and must never be committed. Real deployments inject these
variables directly and have no `.env` file at all.

## Backend

### Runtime

| Variable                   | Required | Default       | Notes                                                                                                      |
| -------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                 | no       | `development` | `development` \| `test` \| `production`. Controls production-only validation and dev-only error detail.    |
| `PORT`                     | no       | `4000`        | 1–65535.                                                                                                   |
| `HOST`                     | no       | `0.0.0.0`     | Bind address.                                                                                              |
| `APP_VERSION`              | no       | `0.1.0`       | Reported by health checks and stamped on every log line, so a deployed build is identifiable.              |
| `SHUTDOWN_TIMEOUT_SECONDS` | no       | `15`          | Grace period for in-flight requests on SIGTERM. A payment write mid-transaction must be allowed to finish. |

### Logging

| Variable     | Required | Default           | Notes                                                                                         |
| ------------ | -------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`  | no       | `info`            | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`. Tests run `silent`. |
| `LOG_PRETTY` | no       | on in development | Human-readable logs. Leave unset in production so logs stay machine-parseable JSON.           |

### Database

| Variable            | Required | Default                          | Notes                                                                                                                            |
| ------------------- | -------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`      | **yes**  | —                                | Must start `postgres://` or `postgresql://`. There is no embedded-database fallback: production must never silently run on one.  |
| `TEST_DATABASE_URL` | no       | local test database on port 5544 | Used by the integration test project. **A test run truncates this database** — never point it at development or production data. |

The Prisma 7 CLI reads the connection URL from `backend/prisma.config.ts` (Prisma 7 no longer
accepts `url` inside `schema.prisma`). The application runtime builds its own connection
through the `pg` driver adapter in `backend/src/lib/prisma.ts`.

### Security

| Variable                  | Required | Default                 | Notes                                                                                                                                                                                                                                                                                                |
| ------------------------- | -------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ORIGINS`            | no       | `http://localhost:5173` | Comma-separated exact origins; trimmed and de-duplicated. In production a wildcard is rejected, and so is any non-HTTPS origin other than localhost.                                                                                                                                                 |
| `RATE_LIMIT_WINDOW_MS`    | no       | `60000`                 | Global limiter window.                                                                                                                                                                                                                                                                               |
| `RATE_LIMIT_MAX_REQUESTS` | no       | `300`                   | Global requests per window per IP. Auth, payment and webhook routes add their own tighter limits.                                                                                                                                                                                                    |
| `JSON_BODY_LIMIT`         | no       | `256kb`                 | Maximum JSON body, and the cap on a raw webhook body. File uploads have their own limits: `UPLOAD_MAX_BYTES` below, and 5MB for a statement import.                                                                                                                                                  |
| `TRUST_PROXY_HOPS`        | no       | `0`                     | Number of reverse proxies in front of the API. **Set this correctly in production.** An explicit hop count is used instead of `trust proxy: true`, because trusting any `X-Forwarded-For` would let a client forge its IP and evade rate limiting — and would corrupt the IP recorded in audit logs. |

### Authentication

No defaults are provided for the two secrets, in any environment. A default signing key is a
forgeable session, and a value committed to a repository eventually reaches production — so
the API refuses to start without them rather than starting insecurely.

| Variable                     | Required | Default                 | Notes                                                                                                                                                                                                                               |
| ---------------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`          | **yes**  | —                       | At least 32 characters of randomness. Signs access and intermediate tokens. Generate: `node -e "console.log(require(&#39;node:crypto&#39;).randomBytes(48).toString(&#39;base64url&#39;))"`                                         |
| `MFA_ENCRYPTION_KEY`         | **yes**  | —                       | Exactly 32 bytes, base64-encoded: the AES-256-GCM key protecting TOTP secrets at rest. **If it is lost or changed, every enrolled authenticator stops verifying and those users must re-enrol.** Treat it like a database password. |
| `ACCESS_TOKEN_TTL_MINUTES`   | no       | `15`                    | Bounds how long a _stolen_ access token is usable. Revocation itself is immediate, because every request re-reads the session.                                                                                                      |
| `REFRESH_TOKEN_TTL_DAYS`     | no       | `30`                    | Absolute session lifetime. Refreshing renews activity, never this ceiling.                                                                                                                                                          |
| `MFA_CHALLENGE_TTL_MINUTES`  | no       | `5`                     | Validity of the intermediate token between a correct password and a completed second factor. Long enough to open an authenticator app, no longer.                                                                                   |
| `MFA_ISSUER`                 | no       | `School Finance System` | The label shown beside the code in the user&#39;s authenticator app.                                                                                                                                                                |
| `MAX_FAILED_LOGIN_ATTEMPTS`  | no       | `5`                     | Consecutive failures before lockout. A failed second factor counts towards the same threshold.                                                                                                                                      |
| `ACCOUNT_LOCK_MINUTES`       | no       | `15`                    | How long a locked account stays locked. An administrator can clear it sooner.                                                                                                                                                       |
| `PASSWORD_RESET_TTL_MINUTES` | no       | `60`                    | Validity of a reset link. Short, because it travels over a channel the school does not control.                                                                                                                                     |
| `REFRESH_COOKIE_NAME`        | no       | `sfs_refresh`           | Cookie holding the refresh token. Always httpOnly, and scoped to `/api/v1/auth`.                                                                                                                                                    |
| `REFRESH_COOKIE_SAMESITE`    | no       | `strict`                | `strict`                                                                                                                                                                                                                            | `lax` | `none`. **`none` is rejected in production**: it sends the cookie on every cross-site request, which is only defensible with CSRF protection in place. |
| `REFRESH_COOKIE_DOMAIN`      | no       | —                       | Only needed when the API and the web client sit on different subdomains.                                                                                                                                                            |

`Secure` is forced on for the refresh cookie in production regardless of configuration.

### Payments (Phase 5)

The sandbox provider is a **local simulator, not a bank**. It makes no outbound request to
anything and settles only when a correctly signed callback is posted to
`/api/v1/payment-webhooks/SANDBOX`, which is what makes the whole provider path — initiation,
signature verification, replay rejection, transactional finalisation — exercisable in
development and CI without credentials, without a network and without real money.

**The API refuses to start with the sandbox enabled when `NODE_ENV=production.`** A simulator
that can mint payment confirmations must not be reachable anywhere a confirmation credits a
real student's account. The webhook secret is validated in _every_ environment, not only
production, because a developer whose machine credits payments on an unsigned POST learns the
wrong lesson about what that endpoint guarantees.

| Variable                           | Required             | Default | Notes                                                                                                                                                                                                                    |
| ---------------------------------- | -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PAYMENT_SANDBOX_ENABLED`          | no                   | `false` | Enables the simulator. **Rejected outright in production.**                                                                                                                                                              |
| `PAYMENT_SANDBOX_WEBHOOK_SECRET`   | when sandbox enabled | —       | HMAC-SHA256 key for signing and verifying sandbox callbacks. At least 32 characters, no default anywhere: a known webhook secret is a forgeable payment confirmation, which is a forgeable credit to a family's account. |
| `PAYMENT_WEBHOOK_MAX_SKEW_SECONDS` | no                   | `120`   | How far a callback's signed timestamp may be from the server clock before it is refused as a **replay**. Range 10–900. Anything older than the window is a captured request being sent again.                            |

Credentials for the three named Rwandan channels are deliberately absent: no adapter exists
for them yet, because whether they offer a payment-notification API is still unconfirmed (see
[OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) #1 and #2). They are collected through the manual
verification workflow, which needs no credentials at all.

### Proof-of-payment uploads (Phase 5)

| Variable              | Required | Default         | Notes                                                                                                                                                                                                             |
| --------------------- | -------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UPLOAD_STORAGE_PATH` | no       | `./var/uploads` | Where bank slips and transfer confirmations are written. **Must be outside any web-servable path.** The API serves no static files at all, so this holds by construction rather than by configuration discipline. |
| `UPLOAD_MAX_BYTES`    | no       | `5242880` (5MB) | Per-file ceiling, 1KB–25MB. A bank slip is a photo or a one-page PDF.                                                                                                                                             |

Bank statements are **not** written to this path. A statement is a transport for rows that are
themselves stored, so it is parsed in memory and discarded, with only its SHA-256 kept so the
same export cannot be imported twice. A bank slip is evidence behind one credit and has to
still be there years later, which is why it is stored.

No malware scanner is configured. `payment_evidence.scan_state` records `SKIPPED` honestly
rather than defaulting to `CLEAN`, so a bursar opening a slip can tell an unscanned file from a
clean one — see [SECURITY.md](SECURITY.md).

### Local infrastructure (docker-compose)

| Variable            | Default                  | Notes                                                                                                                                                                         |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PORT`     | `5544`                   | Host port for the container. Not 5432, because developer machines commonly already run PostgreSQL there. If you change it, update `DATABASE_URL` and `TEST_DATABASE_URL` too. |
| `POSTGRES_USER`     | `sfs`                    | Local development only.                                                                                                                                                       |
| `POSTGRES_PASSWORD` | `sfs_local_dev_password` | Local development only — never reuse anywhere real.                                                                                                                           |
| `POSTGRES_DB`       | `school_finance`         | The companion `school_finance_test` database is created on first container start by `infra/postgres/init/`.                                                                   |

## Frontend

Vite only exposes variables prefixed `VITE_`. **Anything with that prefix is compiled into
the JavaScript bundle and is public.** No secret, API key or provider credential may ever be
given a `VITE_` name.

| Variable            | Required | Default     | Notes                                                                                                                                 |
| ------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL` | no       | same origin | e.g. `http://localhost:4000` in development. Empty means same-origin requests, which is the usual production setup behind one domain. |
| `VITE_APP_VERSION`  | no       | —           | Optional build stamp for support.                                                                                                     |

## Arriving in later phases

These are listed so the deployment story is not a surprise later. They are not read yet.

| Variable                   | Phase | Purpose                                                                                                                        |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| `PAYMENT_PROVIDER_*`       | —     | Per-adapter credentials, once a Rwandan channel's integration is confirmed. One block per adapter, alongside the sandbox pair. |
| `CONTENT_SCANNER_*`        | —     | A malware scanner for uploaded proof of payment, once the school provides one. The port exists; the adapter does not.          |
| `SMS_PROVIDER_*`, `SMTP_*` | 6     | Notification channels.                                                                                                         |
| `ERROR_TRACKING_DSN`       | 14    | Error reporting.                                                                                                               |

## Secrets handling

- Secrets are injected by the deployment platform, never committed and never baked into an
  image.
- The logger's redaction list covers authorisation headers, cookies, passwords, tokens, MFA
  secrets, webhook signatures and API keys.
- Health checks and error responses never include the connection string, which contains
  credentials; database probe failures report a fixed message instead of the driver's.
