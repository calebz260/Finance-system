-- Financial integrity rules that the Prisma schema language cannot express.
--
-- These live in the database rather than only in the service layer because a violation
-- here corrupts money. A bug, a future bulk operation or a maintenance script can all
-- bypass application code; none of them can bypass a check constraint.

-- ------------------------------------------------------------------ fee_categories
-- A code is an identifier, not a label. Blank codes would collide in imports and
-- reports where the code is what a human types.
ALTER TABLE "fee_categories"
  ADD CONSTRAINT "fee_categories_code_not_blank_check"
  CHECK (btrim("code") <> '');

-- ------------------------------------------------------------- fee_structure_items
-- A fee line is never negative. Relief is expressed as an adjustment, which carries a
-- reason and an approver; a negative fee line would be an unapproved, unattributed
-- discount hidden inside the price list.
ALTER TABLE "fee_structure_items"
  ADD CONSTRAINT "fee_structure_items_amount_non_negative_check"
  CHECK ("amount" >= 0);

-- ------------------------------------------------------------------ fee_structures
-- A structure that names a class must be consistent about it: the class narrows the
-- level, so naming a class without a level would leave the applicability filter
-- ambiguous about which level the class belongs to.
ALTER TABLE "fee_structures"
  ADD CONSTRAINT "fee_structures_class_requires_level_check"
  CHECK ("class_section_id" IS NULL OR "level_id" IS NOT NULL);

-- ------------------------------------------------------------------ student_charges
-- A charge is never negative or zero-by-accident. Zero is permitted -- a fully
-- scholarship-funded place can legitimately be charged nothing -- but negative is not,
-- because a negative charge is a credit wearing a charge's clothes and would bypass the
-- adjustment approval workflow entirely.
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_amount_non_negative_check"
  CHECK ("amount" >= 0);

-- A voided charge must say who voided it and why. Without this, "void" becomes a quiet
-- delete: the row survives but the decision behind it does not.
ALTER TABLE "student_charges"
  ADD CONSTRAINT "student_charges_void_requires_actor_check"
  CHECK (
    "status" <> 'VOID'
    OR ("voided_by_user_id" IS NOT NULL AND "voided_at" IS NOT NULL AND btrim(coalesce("void_reason", '')) <> '')
  );

-- Duplicate-charge protection (ADR-019).
--
-- Two partial indexes rather than one, because the key branches on whether the charge is
-- termly or annual, and because PostgreSQL treats NULLs as distinct -- a single index
-- over a nullable term_id would silently permit duplicates of every annual charge.
--
-- Both exclude VOID rows: a charge raised in error is voided and must then be re-raisable
-- correctly. Both also leave ad-hoc charges (fee_structure_item_id IS NULL) unconstrained,
-- since NULLs do not conflict -- that is the deliberate escape hatch for a genuine second
-- charge in a category a student already holds.
CREATE UNIQUE INDEX "student_charges_no_duplicate_per_term"
  ON "student_charges" ("school_id", "student_id", "term_id", "fee_structure_item_id")
  WHERE "term_id" IS NOT NULL AND "status" <> 'VOID';

CREATE UNIQUE INDEX "student_charges_no_duplicate_per_year"
  ON "student_charges" ("school_id", "student_id", "academic_year_id", "fee_structure_item_id")
  WHERE "term_id" IS NULL AND "status" <> 'VOID';

-- ------------------------------------------------------------------ fee_adjustments
-- An adjustment amount is strictly positive. Direction is carried by `type`
-- (SURCHARGE debits, everything else credits), so a zero or negative amount would be a
-- no-op record or a sign-convention trap.
ALTER TABLE "fee_adjustments"
  ADD CONSTRAINT "fee_adjustments_amount_positive_check"
  CHECK ("amount" > 0);

-- A percentage adjustment carries its rate and a fixed one does not, so the stored
-- amount can always be explained by the method that produced it.
ALTER TABLE "fee_adjustments"
  ADD CONSTRAINT "fee_adjustments_percentage_consistency_check"
  CHECK (
    ("method" = 'PERCENTAGE' AND "percentage" IS NOT NULL AND "percentage" > 0 AND "percentage" <= 100)
    OR ("method" = 'FIXED' AND "percentage" IS NULL)
  );

-- A decided adjustment names its decider and when. An approval with no approver is
-- exactly the unattributed write-off this workflow exists to prevent.
ALTER TABLE "fee_adjustments"
  ADD CONSTRAINT "fee_adjustments_decision_requires_actor_check"
  CHECK (
    "status" NOT IN ('APPROVED', 'REJECTED')
    OR ("decided_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL)
  );

-- A reversal names its actor and its reason, for the same reason a void does.
ALTER TABLE "fee_adjustments"
  ADD CONSTRAINT "fee_adjustments_reversal_requires_actor_check"
  CHECK (
    "status" <> 'REVERSED'
    OR ("reversed_by_user_id" IS NOT NULL AND "reversed_at" IS NOT NULL AND btrim(coalesce("reversal_reason", '')) <> '')
  );

-- A reason is not optional on a record that reduces what a family owes.
ALTER TABLE "fee_adjustments"
  ADD CONSTRAINT "fee_adjustments_reason_not_blank_check"
  CHECK (btrim("reason") <> '');

-- ---------------------------------------------------------------------- charge_runs
ALTER TABLE "charge_runs"
  ADD CONSTRAINT "charge_runs_counts_non_negative_check"
  CHECK ("students_matched" >= 0 AND "charges_created" >= 0 AND "charges_skipped" >= 0 AND "total_amount" >= 0);
