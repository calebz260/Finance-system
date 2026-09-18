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
| `JSON_BODY_LIMIT`         | no       | `256kb`                 | Maximum JSON body. File uploads get their own limits when they arrive in Phase 5.                                                                                                                                                                                                                    |
| `TRUST_PROXY_HOPS`        | no       | `0`                     | Number of reverse proxies in front of the API. **Set this correctly in production.** An explicit hop count is used instead of `trust proxy: true`, because trusting any `X-Forwarded-For` would let a client forge its IP and evade rate limiting — and would corrupt the IP recorded in audit logs. |

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

| Variable                                  | Phase | Purpose                                                                            |
| ----------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | 2     | Token signing. Distinct, long, random, rotated.                                    |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`   | 2     | Session lifetimes.                                                                 |
| `MFA_ISSUER`                              | 2     | TOTP issuer label shown in authenticator apps.                                     |
| `PAYMENT_PROVIDER_*`                      | 5     | Per-adapter credentials and webhook signing secrets.                               |
| `UPLOAD_STORAGE_PATH`, `UPLOAD_MAX_BYTES` | 5     | Proof-of-payment and bank statement uploads, stored outside any web-servable path. |
| `SMS_PROVIDER_*`, `SMTP_*`                | 6     | Notification channels.                                                             |
| `ERROR_TRACKING_DSN`                      | 14    | Error reporting.                                                                   |

## Secrets handling

- Secrets are injected by the deployment platform, never committed and never baked into an
  image.
- The logger's redaction list covers authorisation headers, cookies, passwords, tokens, MFA
  secrets, webhook signatures and API keys.
- Health checks and error responses never include the connection string, which contains
  credentials; database probe failures report a fixed message instead of the driver's.
