-- Phase 4, part two: the financial ledger.
--
-- Splits the single `fee_adjustments` table into the business records the formal data
-- model names -- discounts, scholarships and their per-student awards, waivers and
-- authorised adjustments -- and introduces the two tables the balance is actually
-- computed from: `student_financial_accounts` and the insert-only `financial_entries`.
--
-- On the DROP below: `fee_adjustments` was created earlier in this same development
-- session by the immediately preceding migration, has never been committed or applied
-- anywhere else, and was verified empty (0 rows) before this migration was written. No
-- financial data exists to lose. Every other statement here is additive.
--
-- Why a ledger rather than summing the source tables: a balance derived from five
-- different tables has five chances to double-count, and every new relief type adds a
-- term to the formula. Entries make the formula closed -- SUM(DEBIT) - SUM(CREDIT) -- so
-- Phase 5 payments arrive as a new source value rather than as a change to how money is
-- counted.

/*
  Warnings:

  - You are about to drop the `fee_adjustments` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "entry_direction" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "financial_entry_source" AS ENUM ('CHARGE', 'DISCOUNT', 'SCHOLARSHIP', 'WAIVER', 'ADJUSTMENT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "approval_status" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVERSED');

-- CreateEnum
CREATE TYPE "financial_account_status" AS ENUM ('ACTIVE', 'CLOSED');

-- DropForeignKey
ALTER TABLE "fee_adjustments" DROP CONSTRAINT "fee_adjustments_academic_year_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_adjustments" DROP CONSTRAINT "fee_adjustments_decided_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_adjustments" DROP CONSTRAINT "fee_adjustments_requested_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_adjustments" DROP CONSTRAINT "fee_adjustments_reversed_by_user_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_adjustments" DROP CONSTRAINT "fee_adjustments_school_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_adjustments" DROP CONSTRAINT "fee_adjustments_student_charge_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_adjustments" DROP CONSTRAINT "fee_adjustments_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_adjustments" DROP CONSTRAINT "fee_adjustments_term_id_fkey";

-- DropTable
DROP TABLE "fee_adjustments";

-- DropEnum
DROP TYPE "adjustment_status";

-- DropEnum
DROP TYPE "adjustment_type";

-- CreateTable
CREATE TABLE "discounts" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "student_charge_id" UUID,
    "academic_year_id" UUID NOT NULL,
    "term_id" UUID,
    "method" "adjustment_method" NOT NULL DEFAULT 'FIXED',
    "percentage" DECIMAL(5,2),
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "approval_status" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversal_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scholarships" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sponsor" TEXT,
    "default_method" "adjustment_method" NOT NULL DEFAULT 'FIXED',
    "default_percentage" DECIMAL(5,2),
    "default_amount" DECIMAL(14,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "scholarships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_scholarships" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "scholarship_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "student_charge_id" UUID,
    "academic_year_id" UUID NOT NULL,
    "term_id" UUID,
    "method" "adjustment_method" NOT NULL DEFAULT 'FIXED',
    "percentage" DECIMAL(5,2),
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "approval_status" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversal_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "student_scholarships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_waivers" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "student_charge_id" UUID,
    "academic_year_id" UUID NOT NULL,
    "term_id" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "approval_status" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversal_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "fee_waivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_adjustments" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "student_charge_id" UUID,
    "academic_year_id" UUID NOT NULL,
    "term_id" UUID,
    "direction" "entry_direction" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "approval_status" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversal_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "financial_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_financial_accounts" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'RWF',
    "status" "financial_account_status" NOT NULL DEFAULT 'ACTIVE',
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "student_financial_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_entries" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "term_id" UUID,
    "entry_type" "entry_direction" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "source" "financial_entry_source" NOT NULL,
    "student_charge_id" UUID,
    "discount_id" UUID,
    "student_scholarship_id" UUID,
    "fee_waiver_id" UUID,
    "financial_adjustment_id" UUID,
    "description" TEXT NOT NULL,
    "reversal_of_entry_id" UUID,
    "posted_by_user_id" UUID NOT NULL,
    "posted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discounts_school_id_student_id_status_idx" ON "discounts"("school_id", "student_id", "status");

-- CreateIndex
CREATE INDEX "discounts_school_id_academic_year_id_term_id_status_idx" ON "discounts"("school_id", "academic_year_id", "term_id", "status");

-- CreateIndex
CREATE INDEX "discounts_student_charge_id_idx" ON "discounts"("student_charge_id");

-- CreateIndex
CREATE INDEX "scholarships_school_id_is_active_idx" ON "scholarships"("school_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "scholarships_school_id_code_key" ON "scholarships"("school_id", "code");

-- CreateIndex
CREATE INDEX "student_scholarships_school_id_student_id_status_idx" ON "student_scholarships"("school_id", "student_id", "status");

-- CreateIndex
CREATE INDEX "student_scholarships_school_id_scholarship_id_academic_year_idx" ON "student_scholarships"("school_id", "scholarship_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "student_scholarships_student_charge_id_idx" ON "student_scholarships"("student_charge_id");

-- CreateIndex
CREATE INDEX "fee_waivers_school_id_student_id_status_idx" ON "fee_waivers"("school_id", "student_id", "status");

-- CreateIndex
CREATE INDEX "fee_waivers_school_id_academic_year_id_term_id_status_idx" ON "fee_waivers"("school_id", "academic_year_id", "term_id", "status");

-- CreateIndex
CREATE INDEX "fee_waivers_student_charge_id_idx" ON "fee_waivers"("student_charge_id");

-- CreateIndex
CREATE INDEX "financial_adjustments_school_id_student_id_status_idx" ON "financial_adjustments"("school_id", "student_id", "status");

-- CreateIndex
CREATE INDEX "financial_adjustments_school_id_academic_year_id_term_id_st_idx" ON "financial_adjustments"("school_id", "academic_year_id", "term_id", "status");

-- CreateIndex
CREATE INDEX "financial_adjustments_student_charge_id_idx" ON "financial_adjustments"("student_charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_financial_accounts_student_id_key" ON "student_financial_accounts"("student_id");

-- CreateIndex
CREATE INDEX "student_financial_accounts_school_id_status_idx" ON "student_financial_accounts"("school_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "financial_entries_reversal_of_entry_id_key" ON "financial_entries"("reversal_of_entry_id");

-- CreateIndex
CREATE INDEX "financial_entries_school_id_student_id_academic_year_id_ter_idx" ON "financial_entries"("school_id", "student_id", "academic_year_id", "term_id");

-- CreateIndex
CREATE INDEX "financial_entries_account_id_posted_at_idx" ON "financial_entries"("account_id", "posted_at");

-- CreateIndex
CREATE INDEX "financial_entries_school_id_source_posted_at_idx" ON "financial_entries"("school_id", "source", "posted_at");

-- CreateIndex
CREATE INDEX "financial_entries_student_charge_id_idx" ON "financial_entries"("student_charge_id");

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_student_charge_id_fkey" FOREIGN KEY ("student_charge_id") REFERENCES "student_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_reversed_by_user_id_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scholarships" ADD CONSTRAINT "scholarships_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_scholarships" ADD CONSTRAINT "student_scholarships_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_scholarships" ADD CONSTRAINT "student_scholarships_scholarship_id_fkey" FOREIGN KEY ("scholarship_id") REFERENCES "scholarships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_scholarships" ADD CONSTRAINT "student_scholarships_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_scholarships" ADD CONSTRAINT "student_scholarships_student_charge_id_fkey" FOREIGN KEY ("student_charge_id") REFERENCES "student_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_scholarships" ADD CONSTRAINT "student_scholarships_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_scholarships" ADD CONSTRAINT "student_scholarships_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_scholarships" ADD CONSTRAINT "student_scholarships_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_scholarships" ADD CONSTRAINT "student_scholarships_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_scholarships" ADD CONSTRAINT "student_scholarships_reversed_by_user_id_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_student_charge_id_fkey" FOREIGN KEY ("student_charge_id") REFERENCES "student_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_reversed_by_user_id_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_student_charge_id_fkey" FOREIGN KEY ("student_charge_id") REFERENCES "student_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_reversed_by_user_id_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_financial_accounts" ADD CONSTRAINT "student_financial_accounts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_financial_accounts" ADD CONSTRAINT "student_financial_accounts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "student_financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_student_charge_id_fkey" FOREIGN KEY ("student_charge_id") REFERENCES "student_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_discount_id_fkey" FOREIGN KEY ("discount_id") REFERENCES "discounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_student_scholarship_id_fkey" FOREIGN KEY ("student_scholarship_id") REFERENCES "student_scholarships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_fee_waiver_id_fkey" FOREIGN KEY ("fee_waiver_id") REFERENCES "fee_waivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_financial_adjustment_id_fkey" FOREIGN KEY ("financial_adjustment_id") REFERENCES "financial_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_posted_by_user_id_fkey" FOREIGN KEY ("posted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_reversal_of_entry_id_fkey" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "financial_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
