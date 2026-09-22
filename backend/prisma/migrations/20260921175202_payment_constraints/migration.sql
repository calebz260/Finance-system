-- Integrity rules for payments.
--
-- Same principle as the Phase 4 ledger constraints: the rules here are the ones that, if
-- broken, produce a *wrong balance* rather than a bad screen, so they are enforced by the
-- database and not only by the service that normally writes these rows.
--
-- The two that carry the most weight are at the bottom: the extended source check, which
-- makes a PAYMENT entry impossible without the payment that justifies it, and
-- `financial_entries_one_opening_per_payment`, which makes a second credit for one
-- payment impossible however many callbacks arrive and however concurrently.

-- ---------------------------------------------------------------------- payments

-- A payment amount is strictly positive. Zero moves nothing and should not be recorded;
-- negative would be a refund expressed as a payment, which is a second way to say the
-- same thing and therefore a second way to get the sign wrong.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive_check" CHECK ("amount" > 0);

-- ISO-4217, upper case. `Money` refuses to combine currencies, so a lower-cased or
-- mistyped code would surface as an arithmetic failure deep inside a balance rather than
-- as a rejected write.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- The shape a parent reads out over the phone: `PAY-2026-000001234`. The prefix is
-- school-configurable, so the check constrains the shape rather than the literal.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_reference_format_check"
  CHECK ("reference" ~ '^[A-Z]{3}-[0-9]{4}-[0-9]{9}$');

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_payer_name_not_blank_check" CHECK (btrim("payer_name") <> '');

-- A credited payment names the person who verified it, and when.
--
-- REVERSED and REFUNDED are included because both are reached only through SUCCESSFUL: a
-- reversal does not erase the verification that preceded it, and a credited payment with
-- no verifier is precisely the unattributed money this workflow exists to prevent.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_verified_requires_actor_check"
  CHECK (
    "status" NOT IN ('SUCCESSFUL', 'REVERSED', 'REFUNDED')
    OR ("verified_by_user_id" IS NOT NULL AND "verified_at" IS NOT NULL)
  );

-- A reversal or refund names its actor and its reason, for the same reason a decision
-- does. Money going back out is as consequential as money coming in.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_reversal_requires_actor_check"
  CHECK (
    "status" NOT IN ('REVERSED', 'REFUNDED')
    OR (
      "reversed_by_user_id" IS NOT NULL
      AND "reversed_at" IS NOT NULL
      AND btrim(coalesce("reversal_reason", '')) <> ''
    )
  );

-- A failure the payer can be told about. "It failed" with no reason is a support call.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_failure_requires_reason_check"
  CHECK ("status" <> 'FAILED' OR btrim(coalesce("failure_reason", '')) <> '');

-- Every terminal outcome is timestamped, so "when did this finish?" is answerable
-- without reading the status history.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_terminal_requires_completed_at_check"
  CHECK (
    "status" IN ('PENDING', 'PROCESSING', 'REQUIRES_REVIEW')
    OR "completed_at" IS NOT NULL
  );

-- A provider-verified payment names the provider that will verify it. Without this a
-- payment could claim provider verification with nothing to verify against -- which is
-- how a payment ends up credited on the strength of a client-supplied status.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_provider_requires_key_check"
  CHECK ("verification_method" <> 'PROVIDER' OR "provider_key" IS NOT NULL);

-- Cash is never provider-confirmed. Somebody counted it, and that somebody is the
-- verifier; routing cash through a provider path would mean waiting to credit it on a
-- callback that can never arrive.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_cash_is_manual_check"
  CHECK ("method" <> 'CASH' OR "verification_method" = 'MANUAL');

-- The key and the fingerprint of the request it was first used for travel together. A
-- key with no fingerprint could not distinguish an honest retry from the same key being
-- reused for a different payment, which is the whole reason it is stored.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_idempotency_pair_check"
  CHECK (("idempotency_key" IS NULL) = ("idempotency_fingerprint" IS NULL));

-- ---------------------------------------------------------- payment_transactions

ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_requested_amount_positive_check"
  CHECK ("requested_amount" > 0);

ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_confirmed_amount_positive_check"
  CHECK ("confirmed_amount" IS NULL OR "confirmed_amount" > 0);

ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_currency_format_check"
  CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_internal_reference_not_blank_check"
  CHECK (btrim("internal_reference") <> '');

-- A succeeded attempt carries what the provider confirmed, the provider's own identifier
-- for it, and when it finished. A SUCCEEDED row missing the confirmed amount would let
-- the amount comparison that guards crediting be skipped rather than failed.
ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_succeeded_requires_confirmation_check"
  CHECK (
    "status" <> 'SUCCEEDED'
    OR (
      "confirmed_amount" IS NOT NULL
      AND "provider_transaction_id" IS NOT NULL
      AND "completed_at" IS NOT NULL
    )
  );

-- -------------------------------------------------------- payment_status_history

-- A transition goes somewhere. A row claiming PENDING became PENDING is noise in the one
-- record a reviewer reads to reconstruct what happened.
ALTER TABLE "payment_status_history"
  ADD CONSTRAINT "payment_status_history_is_a_transition_check"
  CHECK ("from_status" IS NULL OR "from_status" <> "to_status");

-- ------------------------------------------------------------- payment_evidence

ALTER TABLE "payment_evidence"
  ADD CONSTRAINT "payment_evidence_byte_size_positive_check" CHECK ("byte_size" > 0);

-- SHA-256, lower-case hex. Fixed width because a truncated or differently-encoded digest
-- would silently stop being comparable, and comparability is the only reason it is kept.
ALTER TABLE "payment_evidence"
  ADD CONSTRAINT "payment_evidence_checksum_format_check"
  CHECK ("checksum" ~ '^[0-9a-f]{64}$');

ALTER TABLE "payment_evidence"
  ADD CONSTRAINT "payment_evidence_file_name_not_blank_check"
  CHECK (btrim("file_name") <> '');

-- The storage key is server-generated and opaque: two hex characters of the digest as a
-- fan-out directory, then the rest of it, then a normalised extension. Rejecting anything
-- else in the database as well as in the code means a path-traversal key cannot be
-- persisted even by a write that bypasses the application.
ALTER TABLE "payment_evidence"
  ADD CONSTRAINT "payment_evidence_storage_key_safe_check"
  CHECK ("storage_key" ~ '^[0-9a-f]{2}/[0-9a-f]{62}[.][a-z0-9]{2,5}$');

-- -------------------------------------------------------- payment_webhook_events

ALTER TABLE "payment_webhook_events"
  ADD CONSTRAINT "payment_webhook_events_payload_digest_format_check"
  CHECK ("payload_digest" ~ '^[0-9a-f]{64}$');

ALTER TABLE "payment_webhook_events"
  ADD CONSTRAINT "payment_webhook_events_event_id_not_blank_check"
  CHECK (btrim("event_id") <> '');

-- ------------------------------------------------------------- financial_entries
--
-- The ledger's single-source rule, restated to include payments.
--
-- Corrected forward rather than by editing `20260920153000_ledger_source_check_fix`, per
-- the rule in docs/DATABASE.md: a migration that has been applied anywhere is never
-- rewritten.
--
-- What changes: a PAYMENT entry must now name its payment, and no other source may name
-- one. The earlier version permitted a PAYMENT entry with no source reference at all,
-- because the column it would point at did not exist yet -- exactly the placeholder this
-- replaces.
--
-- `student_charge_id` keeps its existing meaning throughout: on anything that is not
-- itself a charge entry it is context ("which charge is this against?"), not the source,
-- which is what makes "how much has been taken off this charge?" one indexed read. A
-- payment allocated to a specific charge in a later phase therefore needs no schema
-- change here.

ALTER TABLE "financial_entries"
  DROP CONSTRAINT "financial_entries_source_reference_check";

ALTER TABLE "financial_entries"
  ADD CONSTRAINT "financial_entries_source_reference_check"
  CHECK (
    CASE "source"
      WHEN 'CHARGE' THEN
        "student_charge_id" IS NOT NULL
        AND "discount_id" IS NULL
        AND "student_scholarship_id" IS NULL
        AND "fee_waiver_id" IS NULL
        AND "financial_adjustment_id" IS NULL
        AND "payment_id" IS NULL
      WHEN 'DISCOUNT' THEN
        "discount_id" IS NOT NULL
        AND "student_scholarship_id" IS NULL
        AND "fee_waiver_id" IS NULL
        AND "financial_adjustment_id" IS NULL
        AND "payment_id" IS NULL
      WHEN 'SCHOLARSHIP' THEN
        "student_scholarship_id" IS NOT NULL
        AND "discount_id" IS NULL
        AND "fee_waiver_id" IS NULL
        AND "financial_adjustment_id" IS NULL
        AND "payment_id" IS NULL
      WHEN 'WAIVER' THEN
        "fee_waiver_id" IS NOT NULL
        AND "discount_id" IS NULL
        AND "student_scholarship_id" IS NULL
        AND "financial_adjustment_id" IS NULL
        AND "payment_id" IS NULL
      WHEN 'ADJUSTMENT' THEN
        "financial_adjustment_id" IS NOT NULL
        AND "discount_id" IS NULL
        AND "student_scholarship_id" IS NULL
        AND "fee_waiver_id" IS NULL
        AND "payment_id" IS NULL
      WHEN 'PAYMENT' THEN
        "payment_id" IS NOT NULL
        AND "discount_id" IS NULL
        AND "student_scholarship_id" IS NULL
        AND "fee_waiver_id" IS NULL
        AND "financial_adjustment_id" IS NULL
      ELSE false
    END
  );

-- One verified payment posts one credit.
--
-- This is the index that turns "a duplicate callback must not credit twice" from a rule
-- the service remembers into a rule the database enforces. Two callbacks delivered
-- simultaneously, a provider retrying after a timeout, a bursar double-clicking Verify
-- and two concurrent finalisation transactions all end up attempting a second insert
-- here, and all of them lose.
--
-- Scoped to opening entries: the compensating DEBIT a reversal or refund posts carries
-- `reversal_of_entry_id`, so it is excluded and remains possible.
CREATE UNIQUE INDEX "financial_entries_one_opening_per_payment"
  ON "financial_entries" ("payment_id")
  WHERE "source" = 'PAYMENT' AND "reversal_of_entry_id" IS NULL;
