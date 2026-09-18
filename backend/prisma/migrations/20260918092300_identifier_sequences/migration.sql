-- CreateEnum
CREATE TYPE "sequence_kind" AS ENUM ('STUDENT', 'RECEIPT');

-- CreateTable
CREATE TABLE "identifier_sequences" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "kind" "sequence_kind" NOT NULL,
    "year" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "identifier_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identifier_sequences_school_id_kind_year_key" ON "identifier_sequences"("school_id", "kind", "year");

-- AddForeignKey
ALTER TABLE "identifier_sequences" ADD CONSTRAINT "identifier_sequences_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
