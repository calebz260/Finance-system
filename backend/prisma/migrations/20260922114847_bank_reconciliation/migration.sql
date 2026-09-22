-- CreateEnum
CREATE TYPE "bank_statement_direction" AS ENUM ('MONEY_IN', 'MONEY_OUT');

-- CreateEnum
CREATE TYPE "statement_line_match_status" AS ENUM ('UNMATCHED', 'MATCHED', 'IGNORED', 'AMBIGUOUS');

-- CreateTable
CREATE TABLE "bank_statement_imports" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "provider" "payment_provider_key" NOT NULL,
    "account_label" TEXT,
    "file_name" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "period_start" DATE,
    "period_end" DATE,
    "line_count" INTEGER NOT NULL,
    "total_in" DECIMAL(14,2) NOT NULL,
    "total_out" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "imported_by_user_id" UUID NOT NULL,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "value_date" DATE NOT NULL,
    "narrative" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "direction" "bank_statement_direction" NOT NULL,
    "match_status" "statement_line_match_status" NOT NULL DEFAULT 'UNMATCHED',
    "matched_payment_id" UUID,
    "matched_by_user_id" UUID,
    "matched_at" TIMESTAMPTZ(3),
    "match_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_statement_imports_school_id_imported_at_idx" ON "bank_statement_imports"("school_id", "imported_at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_imports_school_id_checksum_key" ON "bank_statement_imports"("school_id", "checksum");

-- CreateIndex
CREATE INDEX "bank_statement_lines_school_id_match_status_value_date_idx" ON "bank_statement_lines"("school_id", "match_status", "value_date");

-- CreateIndex
CREATE INDEX "bank_statement_lines_import_id_line_number_idx" ON "bank_statement_lines"("import_id", "line_number");

-- CreateIndex
CREATE INDEX "bank_statement_lines_matched_payment_id_idx" ON "bank_statement_lines"("matched_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_import_id_line_number_key" ON "bank_statement_lines"("import_id", "line_number");

-- AddForeignKey
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_imported_by_user_id_fkey" FOREIGN KEY ("imported_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "bank_statement_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_payment_id_fkey" FOREIGN KEY ("matched_payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_matched_by_user_id_fkey" FOREIGN KEY ("matched_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
