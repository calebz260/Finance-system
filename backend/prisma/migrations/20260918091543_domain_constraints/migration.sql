-- Integrity rules that the Prisma schema language cannot express.
--
-- These are enforced in the database on purpose. Application-level checks can be
-- bypassed by a bug, a bulk import or a maintenance script; for rules where a violation
-- would corrupt financial history or make "the current term" ambiguous, the database is
-- the right place to say no.

-- ---------------------------------------------------------------------------- users
-- Every user belongs to a school, except the system-wide Super Administrator.
-- Without this, a bug could create a school-less user whose queries fall outside all
-- tenant scoping.
ALTER TABLE "users"
  ADD CONSTRAINT "users_school_scope_check"
  CHECK ("is_system_administrator" = true OR "school_id" IS NOT NULL);

-- ----------------------------------------------------------------------- user_roles
-- The same role must not be granted twice within one school. A plain UNIQUE cannot
-- express this because `school_id` is nullable and PostgreSQL treats NULLs as distinct,
-- so two partial indexes are used instead.
CREATE UNIQUE INDEX "user_roles_user_role_school_unique"
  ON "user_roles" ("user_id", "role_id", "school_id")
  WHERE "school_id" IS NOT NULL;

CREATE UNIQUE INDEX "user_roles_user_role_system_unique"
  ON "user_roles" ("user_id", "role_id")
  WHERE "school_id" IS NULL;

-- ------------------------------------------------------------------- academic_years
-- At most one current academic year per school. "Which year is now?" must never have two
-- answers: fee structures, charges and reports are all scoped by it.
CREATE UNIQUE INDEX "academic_years_one_current_per_school"
  ON "academic_years" ("school_id")
  WHERE "is_current" = true;

-- A year must not end before it starts.
ALTER TABLE "academic_years"
  ADD CONSTRAINT "academic_years_date_order_check"
  CHECK ("end_date" > "start_date");

-- ---------------------------------------------------------------------------- terms
-- At most one current term per school, for the same reason.
CREATE UNIQUE INDEX "terms_one_current_per_school"
  ON "terms" ("school_id")
  WHERE "is_current" = true;

ALTER TABLE "terms"
  ADD CONSTRAINT "terms_date_order_check"
  CHECK ("end_date" > "start_date");

-- Terms are numbered from 1 within their year.
ALTER TABLE "terms"
  ADD CONSTRAINT "terms_sequence_positive_check"
  CHECK ("sequence" >= 1);

-- ---------------------------------------------------------------------------- levels
ALTER TABLE "levels"
  ADD CONSTRAINT "levels_sequence_positive_check"
  CHECK ("sequence" >= 1);

-- A level cannot be its own next level, which would make promotion loop forever.
ALTER TABLE "levels"
  ADD CONSTRAINT "levels_next_level_not_self_check"
  CHECK ("next_level_id" IS NULL OR "next_level_id" <> "id");

-- A terminal level ends the programme, so it must not chain onward.
ALTER TABLE "levels"
  ADD CONSTRAINT "levels_terminal_has_no_next_check"
  CHECK ("is_terminal" = false OR "next_level_id" IS NULL);

-- ----------------------------------------------------------------------- enrollments
-- One ACTIVE enrolment per student per academic year.
--
-- A plain unique on (student_id, academic_year_id) would be wrong: a student who
-- withdraws in Term 1 and is re-admitted in Term 3 legitimately has two rows for that
-- year. Restricting the constraint to ENROLLED rows keeps that history possible while
-- making a double-enrolment impossible.
CREATE UNIQUE INDEX "enrollments_one_active_per_student_year"
  ON "enrollments" ("student_id", "academic_year_id")
  WHERE "status" = 'ENROLLED';

-- An ended enrolment must have an end date, and an active one must not.
ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_end_date_matches_status_check"
  CHECK (
    ("status" = 'ENROLLED' AND "end_date" IS NULL)
    OR ("status" <> 'ENROLLED' AND "end_date" IS NOT NULL)
  );

ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_date_order_check"
  CHECK ("end_date" IS NULL OR "end_date" >= "start_date");

-- ------------------------------------------------------------------ school_settings
-- A minimum payment amount cannot be negative.
ALTER TABLE "school_settings"
  ADD CONSTRAINT "school_settings_minimum_payment_non_negative_check"
  CHECK ("minimum_payment_amount" >= 0);

-- Retention periods must be positive, so a misconfiguration cannot imply
-- "delete immediately".
ALTER TABLE "school_settings"
  ADD CONSTRAINT "school_settings_retention_positive_check"
  CHECK ("financial_record_retention_years" >= 1 AND "personal_data_retention_years" >= 1);

-- ----------------------------------------------------------------------- students
-- The Student ID format is validated in the application too, but enforcing it here means
-- a bulk import or a manual fix cannot introduce an identifier that receipts and reports
-- would then render inconsistently (Section 7).
ALTER TABLE "students"
  ADD CONSTRAINT "students_student_id_format_check"
  CHECK ("student_id" ~ '^[A-Z]{2,5}-[0-9]{4}-[0-9]{5}$');

ALTER TABLE "students"
  ADD CONSTRAINT "students_admission_year_range_check"
  CHECK ("admission_year" BETWEEN 1900 AND 2999);

-- --------------------------------------------------------------- class_sections
ALTER TABLE "class_sections"
  ADD CONSTRAINT "class_sections_capacity_positive_check"
  CHECK ("capacity" IS NULL OR "capacity" > 0);
