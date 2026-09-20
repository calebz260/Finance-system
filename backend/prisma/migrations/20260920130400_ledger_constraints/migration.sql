-- Integrity rules for the ledger and the records that feed it.
--
-- The rules here are the ones that, if broken, produce a *wrong balance* rather than a
-- bad screen. They are enforced in the database because the balance is the number the
-- whole system exists to get right, and application code is not the only thing that can
-- write to these tables.

-- ------------------------------------------------------------- financial_entries
-- A ledger amount is strictly positive. Direction lives in `entry_type`; a negative
-- amount would mean two ways to express the same movement and two ways to get the sign
-- wrong when summing.
ALTER TABLE "financial_entries"
  ADD CONSTRAINT "financial_entries_amount_positive_check"
  CHECK ("amount" > 0);

-- Every entry names exactly one source record, and the right kind for its `source`.
--
-- Without this an entry could point at a discount while claiming to be a charge, or at
-- nothing at all -- and a balance line that cannot be traced back to the decision behind
-- it is exactly what the ledger exists to prevent. PAYMENT is permitted to carry no
-- source id yet: Phase 5 adds the column it will point at.
ALTER TABLE "financial_entries"
  ADD CONSTRAINT "financial_entries_single_source_check"
  CHECK (
    (
      ("student_charge_id" IS NOT NULL)::int
      + ("discount_id" IS NOT NULL)::int
      + ("student_scholarship_id" IS NOT NULL)::int
      + ("fee_waiver_id" IS NOT NULL)::int
      + ("financial_adjustment_id" IS NOT NULL)::int
    ) = CASE WHEN "source" = 'PAYMENT' THEN 0 ELSE 1 END
  );

ALTER TABLE "financial_entries"
  ADD CONSTRAINT "financial_entries_source_matches_reference_check"
  CHECK (
    ("source" = 'CHARGE'      AND "student_charge_id" IS NOT NULL)
    OR ("source" = 'DISCOUNT'   AND "discount_id" IS NOT NULL)
    OR ("source" = 'SCHOLARSHIP' AND "student_scholarship_id" IS NOT NULL)
    OR ("source" = 'WAIVER'     AND "fee_waiver_id" IS NOT NULL)
    OR ("source" = 'ADJUSTMENT' AND "financial_adjustment_id" IS NOT NULL)
    OR "source" = 'PAYMENT'
  );

-- An entry cannot reverse itself, which would be a row that silently nets to nothing
-- while appearing to be two movements.
ALTER TABLE "financial_entries"
  ADD CONSTRAINT "financial_entries_no_self_reversal_check"
  CHECK ("reversal_of_entry_id" IS NULL OR "reversal_of_entry_id" <> "id");

-- A description is what appears on a statement. An unlabelled ledger line is unusable to
-- the bursar who has to explain it to a parent.
ALTER TABLE "financial_entries"
  ADD CONSTRAINT "financial_entries_description_not_blank_check"
  CHECK (btrim("description") <> '');

-- One charge posts one opening DEBIT. A second would double the student's obligation
-- while every source record still looked correct -- the precise failure the ledger is
-- meant to make impossible.
CREATE UNIQUE INDEX "financial_entries_one_opening_per_charge"
  ON "financial_entries" ("student_charge_id")
  WHERE "source" = 'CHARGE' AND "reversal_of_entry_id" IS NULL;

-- The same, for each kind of relief: an approved discount posts exactly one credit.
-- Approving twice is already blocked by the status transition, but a retried request or
-- a concurrent approval must not be able to get a second credit past it.
CREATE UNIQUE INDEX "financial_entries_one_opening_per_discount"
  ON "financial_entries" ("discount_id")
  WHERE "discount_id" IS NOT NULL AND "reversal_of_entry_id" IS NULL;

CREATE UNIQUE INDEX "financial_entries_one_opening_per_scholarship"
  ON "financial_entries" ("student_scholarship_id")
  WHERE "student_scholarship_id" IS NOT NULL AND "reversal_of_entry_id" IS NULL;

CREATE UNIQUE INDEX "financial_entries_one_opening_per_waiver"
  ON "financial_entries" ("fee_waiver_id")
  WHERE "fee_waiver_id" IS NOT NULL AND "reversal_of_entry_id" IS NULL;

CREATE UNIQUE INDEX "financial_entries_one_opening_per_adjustment"
  ON "financial_entries" ("financial_adjustment_id")
  WHERE "financial_adjustment_id" IS NOT NULL AND "reversal_of_entry_id" IS NULL;

-- --------------------------------------------------- student_financial_accounts
ALTER TABLE "student_financial_accounts"
  ADD CONSTRAINT "student_financial_accounts_closed_requires_timestamp_check"
  CHECK ("status" <> 'CLOSED' OR "closed_at" IS NOT NULL);

-- ------------------------------------------- relief records: shared money rules
-- Every relief and adjustment amount is strictly positive, for the same reason ledger
-- amounts are: direction is carried by the record's type, never by a sign.
ALTER TABLE "discounts"
  ADD CONSTRAINT "discounts_amount_positive_check" CHECK ("amount" > 0);
ALTER TABLE "student_scholarships"
  ADD CONSTRAINT "student_scholarships_amount_positive_check" CHECK ("amount" > 0);
ALTER TABLE "fee_waivers"
  ADD CONSTRAINT "fee_waivers_amount_positive_check" CHECK ("amount" > 0);
ALTER TABLE "financial_adjustments"
  ADD CONSTRAINT "financial_adjustments_amount_positive_check" CHECK ("amount" > 0);

-- A percentage award carries its rate and a fixed one does not, so a stored amount can
-- always be explained by the method that produced it.
ALTER TABLE "discounts"
  ADD CONSTRAINT "discounts_percentage_consistency_check"
  CHECK (
    ("method" = 'PERCENTAGE' AND "percentage" IS NOT NULL AND "percentage" > 0 AND "percentage" <= 100)
    OR ("method" = 'FIXED' AND "percentage" IS NULL)
  );

ALTER TABLE "student_scholarships"
  ADD CONSTRAINT "student_scholarships_percentage_consistency_check"
  CHECK (
    ("method" = 'PERCENTAGE' AND "percentage" IS NOT NULL AND "percentage" > 0 AND "percentage" <= 100)
    OR ("method" = 'FIXED' AND "percentage" IS NULL)
  );

ALTER TABLE "scholarships"
  ADD CONSTRAINT "scholarships_default_percentage_range_check"
  CHECK ("default_percentage" IS NULL OR ("default_percentage" > 0 AND "default_percentage" <= 100));

ALTER TABLE "scholarships"
  ADD CONSTRAINT "scholarships_default_amount_non_negative_check"
  CHECK ("default_amount" IS NULL OR "default_amount" >= 0);

ALTER TABLE "scholarships"
  ADD CONSTRAINT "scholarships_code_not_blank_check"
  CHECK (btrim("code") <> '');

-- A reason is not optional on any record that changes what a family owes.
ALTER TABLE "discounts"
  ADD CONSTRAINT "discounts_reason_not_blank_check" CHECK (btrim("reason") <> '');
ALTER TABLE "student_scholarships"
  ADD CONSTRAINT "student_scholarships_reason_not_blank_check" CHECK (btrim("reason") <> '');
ALTER TABLE "fee_waivers"
  ADD CONSTRAINT "fee_waivers_reason_not_blank_check" CHECK (btrim("reason") <> '');
ALTER TABLE "financial_adjustments"
  ADD CONSTRAINT "financial_adjustments_reason_not_blank_check" CHECK (btrim("reason") <> '');

-- A decision names its decider and when. An approval with no approver is the
-- unattributed write-off the whole workflow exists to prevent.
ALTER TABLE "discounts"
  ADD CONSTRAINT "discounts_decision_requires_actor_check"
  CHECK ("status" NOT IN ('APPROVED', 'REJECTED') OR ("decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL));
ALTER TABLE "student_scholarships"
  ADD CONSTRAINT "student_scholarships_decision_requires_actor_check"
  CHECK ("status" NOT IN ('APPROVED', 'REJECTED') OR ("decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL));
ALTER TABLE "fee_waivers"
  ADD CONSTRAINT "fee_waivers_decision_requires_actor_check"
  CHECK ("status" NOT IN ('APPROVED', 'REJECTED') OR ("decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL));
ALTER TABLE "financial_adjustments"
  ADD CONSTRAINT "financial_adjustments_decision_requires_actor_check"
  CHECK ("status" NOT IN ('APPROVED', 'REJECTED') OR ("decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL));

-- A reversal names its actor and its reason, for the same reason a decision does.
ALTER TABLE "discounts"
  ADD CONSTRAINT "discounts_reversal_requires_actor_check"
  CHECK ("status" <> 'REVERSED' OR ("reversed_by_user_id" IS NOT NULL AND "reversed_at" IS NOT NULL AND btrim(coalesce("reversal_reason", '')) <> ''));
ALTER TABLE "student_scholarships"
  ADD CONSTRAINT "student_scholarships_reversal_requires_actor_check"
  CHECK ("status" <> 'REVERSED' OR ("reversed_by_user_id" IS NOT NULL AND "reversed_at" IS NOT NULL AND btrim(coalesce("reversal_reason", '')) <> ''));
ALTER TABLE "fee_waivers"
  ADD CONSTRAINT "fee_waivers_reversal_requires_actor_check"
  CHECK ("status" <> 'REVERSED' OR ("reversed_by_user_id" IS NOT NULL AND "reversed_at" IS NOT NULL AND btrim(coalesce("reversal_reason", '')) <> ''));
ALTER TABLE "financial_adjustments"
  ADD CONSTRAINT "financial_adjustments_reversal_requires_actor_check"
  CHECK ("status" <> 'REVERSED' OR ("reversed_by_user_id" IS NOT NULL AND "reversed_at" IS NOT NULL AND btrim(coalesce("reversal_reason", '')) <> ''));
