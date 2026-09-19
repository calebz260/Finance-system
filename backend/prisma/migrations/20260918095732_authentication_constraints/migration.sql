-- Authentication integrity rules the Prisma schema language cannot express.

-- ---------------------------------------------------------------------------- users
-- An account with MFA enabled must hold a secret. Without this, a bad write could
-- produce "MFA required, no secret configured", which is unrecoverable for the user:
-- they cannot generate a code, and the sign-in flow would refuse to let them in.
ALTER TABLE "users"
  ADD CONSTRAINT "users_mfa_enabled_requires_secret_check"
  CHECK ("mfa_enabled" = false OR "mfa_secret_encrypted" IS NOT NULL);

-- The failure counter is a count, never negative.
ALTER TABLE "users"
  ADD CONSTRAINT "users_failed_login_attempts_non_negative_check"
  CHECK ("failed_login_attempts" >= 0);

-- ------------------------------------------------------------------------- sessions
-- A session must expire after it began.
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_expiry_after_creation_check"
  CHECK ("expires_at" > "created_at");

-- A revoked session must say why. "Why was I signed out?" is a real support question,
-- and an unexplained revocation hides a security event such as detected token reuse.
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_revoked_has_reason_check"
  CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL));

-- Index for the common lookup: this user's live sessions.
CREATE INDEX "sessions_active_by_user"
  ON "sessions" ("user_id", "last_seen_at" DESC)
  WHERE "revoked_at" IS NULL;

-- ------------------------------------------------------------------ refresh_tokens
ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_expiry_after_issue_check"
  CHECK ("expires_at" > "issued_at");

-- A token that points at a replacement must itself have been used: rotation consumes the
-- old token and issues the new one in the same transaction, so "replaced but never used"
-- would mean the rotation half-applied.
ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_replaced_implies_used_check"
  CHECK ("replaced_by_id" IS NULL OR "used_at" IS NOT NULL);

-- Only one unused token per session may be outstanding at a time. This is the invariant
-- that makes reuse detection meaningful: if several unused tokens could coexist, a stolen
-- one would stay valid alongside the legitimate client's.
CREATE UNIQUE INDEX "refresh_tokens_one_active_per_session"
  ON "refresh_tokens" ("session_id")
  WHERE "used_at" IS NULL;

-- ------------------------------------------------------- password_reset_tokens
ALTER TABLE "password_reset_tokens"
  ADD CONSTRAINT "password_reset_tokens_expiry_after_creation_check"
  CHECK ("expires_at" > "created_at");

-- At most one live reset per user, so requesting a new link invalidates the previous
-- one rather than leaving several valid grants outstanding.
CREATE UNIQUE INDEX "password_reset_tokens_one_active_per_user"
  ON "password_reset_tokens" ("user_id")
  WHERE "used_at" IS NULL;
