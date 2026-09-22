-- Phase 5: payment processing.
--
-- Additive in full. Nothing existing is dropped, renamed or rewritten: the only change to
-- a Phase 4 table is one nullable column, `financial_entries.payment_id`, which is what
-- lets a ledger entry name the payment that justified it. The balance formula is
-- untouched -- a payment is a new *value* of `financial_entry_source`, not a new way of
-- counting money (ADR-022).
--
-- Five new tables:
--
--   payments                 the business-level payment. Holds no balance and no ledger
--                            effect; what it does to an account is the entry it posts.
--   payment_transactions     one attempt against a provider. One-to-many on purpose: a
--                            timed-out attempt may still settle, and collapsing attempts
--                            into an overwritten row is how a duplicate credit happens.
--   payment_status_history   every meaningful transition, insert-only, so "how did this
--                            payment get here?" is answerable months later.
--   payment_evidence         proof attached to a manual claim. Insert-only with
--                            supersession, so replacing a slip is visible.
--   payment_webhook_events   every inbound callback, verified or not. Written before the
--                            callback is acted on, which is what makes processing
--                            idempotent.
--
-- `sequence_kind` gains PAYMENT so payment references come from the same atomic per-year
-- counter as Student IDs. The value is added but not used in this migration, which is
-- required: PostgreSQL will not let a transaction use an enum value it just added.
--
-- The integrity rules -- check constraints and the partial unique indexes that make
-- double-crediting impossible rather than unlikely -- are in the companion
-- `_payment_constraints` migration, following the pattern established in Phase 4.

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('MOBILE_MONEY', 'BANK_TRANSFER', 'BANK_DEPOSIT', 'CASH', 'CHEQUE');

-- CreateEnum
CREATE TYPE "payment_verification_method" AS ENUM ('PROVIDER', 'MANUAL');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESSFUL', 'FAILED', 'CANCELLED', 'REQUIRES_REVIEW', 'REVERSED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "payment_provider_key" AS ENUM ('SANDBOX', 'BANK_OF_KIGALI', 'ZIGAMA_CSS', 'UMWARIMU_SACCO');

-- CreateEnum
CREATE TYPE "payment_transaction_status" AS ENUM ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "payment_status_change_source" AS ENUM ('USER', 'PROVIDER_WEBHOOK', 'PROVIDER_QUERY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "payment_evidence_kind" AS ENUM ('BANK_SLIP', 'TRANSFER_CONFIRMATION', 'REMITTANCE_ADVICE', 'OTHER');

-- CreateEnum
CREATE TYPE "content_scan_state" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "webhook_verification_result" AS ENUM ('VERIFIED', 'SIGNATURE_INVALID', 'REPLAYED', 'MALFORMED', 'UNKNOWN_REFERENCE');

-- AlterEnum
ALTER TYPE "sequence_kind" ADD VALUE 'PAYMENT';

-- AlterTable
ALTER TABLE "financial_entries" ADD COLUMN     "payment_id" UUID;

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "term_id" UUID,
    "reference" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "method" "payment_method" NOT NULL,
    "verification_method" "payment_verification_method" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "provider_key" "payment_provider_key",
    "payer_name" TEXT NOT NULL,
    "payer_phone" TEXT,
    "payer_email" TEXT,
    "external_reference" TEXT,
    "idempotency_key" TEXT,
    "idempotency_fingerprint" TEXT,
    "notes" TEXT,
    "failure_reason" TEXT,
    "initiated_by_user_id" UUID NOT NULL,
    "initiated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "verified_by_user_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "verification_note" TEXT,
    "reversed_by_user_id" UUID,
    "reversed_at" TIMESTAMPTZ(3),
    "reversal_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transactions" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "provider_key" "payment_provider_key" NOT NULL,
    "internal_reference" TEXT NOT NULL,
    "provider_transaction_id" TEXT,
    "requested_amount" DECIMAL(14,2) NOT NULL,
    "confirmed_amount" DECIMAL(14,2),
    "currency" VARCHAR(3) NOT NULL,
    "status" "payment_transaction_status" NOT NULL DEFAULT 'INITIATED',
    "failure_code" TEXT,
    "failure_message" TEXT,
    "provider_metadata" JSONB,
    "initiated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_status_history" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "from_status" "payment_status",
    "to_status" "payment_status" NOT NULL,
    "source" "payment_status_change_source" NOT NULL,
    "reason" TEXT,
    "actor_user_id" UUID,
    "metadata" JSONB,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_evidence" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "kind" "payment_evidence_kind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "scan_state" "content_scan_state" NOT NULL DEFAULT 'SKIPPED',
    "uploaded_by_user_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" UUID NOT NULL,
    "school_id" UUID,
    "provider_key" "payment_provider_key" NOT NULL,
    "event_id" TEXT NOT NULL,
    "payment_id" UUID,
    "payment_transaction_id" UUID,
    "verification" "webhook_verification_result" NOT NULL,
    "signed_at" TIMESTAMPTZ(3),
    "payload_digest" TEXT NOT NULL,
    "safe_metadata" JSONB,
    "resulting_status" "payment_status",
    "request_id" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_school_id_status_initiated_at_idx" ON "payments"("school_id", "status", "initiated_at");

-- CreateIndex
CREATE INDEX "payments_school_id_student_id_initiated_at_idx" ON "payments"("school_id", "student_id", "initiated_at");

-- CreateIndex
CREATE INDEX "payments_school_id_verification_method_status_initiated_at_idx" ON "payments"("school_id", "verification_method", "status", "initiated_at");

-- CreateIndex
CREATE INDEX "payments_account_id_idx" ON "payments"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_school_id_reference_key" ON "payments"("school_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "payments_school_id_idempotency_key_key" ON "payments"("school_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "payment_transactions_payment_id_initiated_at_idx" ON "payment_transactions"("payment_id", "initiated_at");

-- CreateIndex
CREATE INDEX "payment_transactions_school_id_status_initiated_at_idx" ON "payment_transactions"("school_id", "status", "initiated_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_school_id_internal_reference_key" ON "payment_transactions"("school_id", "internal_reference");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transactions_provider_key_provider_transaction_id_key" ON "payment_transactions"("provider_key", "provider_transaction_id");

-- CreateIndex
CREATE INDEX "payment_status_history_payment_id_occurred_at_idx" ON "payment_status_history"("payment_id", "occurred_at");

-- CreateIndex
CREATE INDEX "payment_status_history_school_id_to_status_occurred_at_idx" ON "payment_status_history"("school_id", "to_status", "occurred_at");

-- CreateIndex
CREATE INDEX "payment_evidence_payment_id_uploaded_at_idx" ON "payment_evidence"("payment_id", "uploaded_at");

-- CreateIndex
CREATE INDEX "payment_evidence_school_id_scan_state_idx" ON "payment_evidence"("school_id", "scan_state");

-- CreateIndex
CREATE UNIQUE INDEX "payment_evidence_storage_key_key" ON "payment_evidence"("storage_key");

-- CreateIndex
CREATE INDEX "payment_webhook_events_school_id_received_at_idx" ON "payment_webhook_events"("school_id", "received_at");

-- CreateIndex
CREATE INDEX "payment_webhook_events_provider_key_verification_received_a_idx" ON "payment_webhook_events"("provider_key", "verification", "received_at");

-- CreateIndex
CREATE INDEX "payment_webhook_events_payment_id_idx" ON "payment_webhook_events"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_key_event_id_key" ON "payment_webhook_events"("provider_key", "event_id");

-- CreateIndex
CREATE INDEX "financial_entries_payment_id_idx" ON "financial_entries"("payment_id");

-- AddForeignKey
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "student_financial_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_term_id_fkey" FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_initiated_by_user_id_fkey" FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_verified_by_user_id_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversed_by_user_id_fkey" FOREIGN KEY ("reversed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_status_history" ADD CONSTRAINT "payment_status_history_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_status_history" ADD CONSTRAINT "payment_status_history_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_status_history" ADD CONSTRAINT "payment_status_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_payment_transaction_id_fkey" FOREIGN KEY ("payment_transaction_id") REFERENCES "payment_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
