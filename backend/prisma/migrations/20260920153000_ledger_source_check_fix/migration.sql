-- Correct the ledger's single-source check.
--
-- The version in `20260920130400_ledger_constraints` counted `student_charge_id` as one
-- of the mutually exclusive source references. That was wrong: on a relief entry the
-- charge id is not the *source*, it is the charge the relief was applied **to**, and it
-- is what makes "how much has been taken off this charge?" a single indexed read. The
-- original rule therefore rejected every discount, scholarship and waiver raised against
-- a specific charge.
--
-- Corrected forward rather than by editing the applied migration, per the rule in
-- docs/DATABASE.md: a migration that has been applied anywhere is never rewritten.
--
-- The rule now says: exactly one *source* reference matching `source`, with the other
-- source references null, and `student_charge_id` free to carry context on anything that
-- is not itself a charge entry.

ALTER TABLE "financial_entries"
  DROP CONSTRAINT "financial_entries_single_source_check";

ALTER TABLE "financial_entries"
  DROP CONSTRAINT "financial_entries_source_matches_reference_check";

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
      WHEN 'DISCOUNT' THEN
        "discount_id" IS NOT NULL
        AND "student_scholarship_id" IS NULL
        AND "fee_waiver_id" IS NULL
        AND "financial_adjustment_id" IS NULL
      WHEN 'SCHOLARSHIP' THEN
        "student_scholarship_id" IS NOT NULL
        AND "discount_id" IS NULL
        AND "fee_waiver_id" IS NULL
        AND "financial_adjustment_id" IS NULL
      WHEN 'WAIVER' THEN
        "fee_waiver_id" IS NOT NULL
        AND "discount_id" IS NULL
        AND "student_scholarship_id" IS NULL
        AND "financial_adjustment_id" IS NULL
      WHEN 'ADJUSTMENT' THEN
        "financial_adjustment_id" IS NOT NULL
        AND "discount_id" IS NULL
        AND "student_scholarship_id" IS NULL
        AND "fee_waiver_id" IS NULL
      -- Phase 5. No payment column exists yet, so a payment entry carries no source
      -- reference; the charge id may still be present once payments are allocated.
      WHEN 'PAYMENT' THEN
        "discount_id" IS NULL
        AND "student_scholarship_id" IS NULL
        AND "fee_waiver_id" IS NULL
        AND "financial_adjustment_id" IS NULL
      ELSE false
    END
  );

-- The "one opening entry per charge" index was also too broad: it keyed on
-- `student_charge_id` for CHARGE-sourced rows only, which is correct, but the relief
-- indexes keyed on their own source ids and are unaffected. Re-stated here only so the
-- intent is recorded alongside the corrected check.
