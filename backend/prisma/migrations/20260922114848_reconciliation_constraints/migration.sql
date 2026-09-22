-- Reconciliation invariants the database enforces itself.
--
-- Written as a second migration beside the tables, the same way every other phase has
-- done it: Prisma generates the shape, and the rules that a shape cannot express are
-- declared here, where they hold against every writer — including a future code path, a
-- data fix run by hand, and a migration written in a hurry.
--
-- The rule worth reading twice is the last one. One statement line may be attributed to
-- one payment, and one payment to one line. Two lines claiming the same payment would
-- mean the bank paid the school twice and the school recorded it once; two payments
-- against one line would mean crediting two families for money that arrived once.

-- ---------------------------------------------------- bank_statement_imports

-- A statement with no rows is not a statement.
ALTER TABLE "bank_statement_imports"
  ADD CONSTRAINT "bank_statement_imports_line_count_positive_check" CHECK ("line_count" > 0);

-- Totals are sums of what the file said, so they are non-negative; the direction lives in
-- the line, never in the sign of an amount.
ALTER TABLE "bank_statement_imports"
  ADD CONSTRAINT "bank_statement_imports_totals_non_negative_check"
  CHECK ("total_in" >= 0 AND "total_out" >= 0);

ALTER TABLE "bank_statement_imports"
  ADD CONSTRAINT "bank_statement_imports_currency_format_check"
  CHECK ("currency" ~ '^[A-Z]{3}$');

-- SHA-256, lower-case hex. Fixed width because a truncated digest would silently stop
-- being comparable, and comparability is the whole reason it is stored: it is what
-- refuses the same export a second time.
ALTER TABLE "bank_statement_imports"
  ADD CONSTRAINT "bank_statement_imports_checksum_format_check"
  CHECK ("checksum" ~ '^[0-9a-f]{64}$');

ALTER TABLE "bank_statement_imports"
  ADD CONSTRAINT "bank_statement_imports_file_name_not_blank_check"
  CHECK (btrim("file_name") <> '');

-- A period that ends before it starts is a parsing mistake, not a statement.
ALTER TABLE "bank_statement_imports"
  ADD CONSTRAINT "bank_statement_imports_period_order_check"
  CHECK (
    "period_start" IS NULL
    OR "period_end" IS NULL
    OR "period_start" <= "period_end"
  );

-- ------------------------------------------------------ bank_statement_lines

-- Amounts are strictly positive: a line of zero moves nothing, and a negative one would
-- be a second, contradictory way of expressing direction.
ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_amount_positive_check" CHECK ("amount" > 0);

ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_currency_format_check"
  CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_line_number_positive_check" CHECK ("line_number" > 0);

ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_narrative_not_blank_check"
  CHECK (btrim("narrative") <> '');

-- A matched line names its payment, and nothing else does.
--
-- Without this, `match_status = 'MATCHED'` with no payment would read as reconciled while
-- attributing the money to nobody, and an UNMATCHED line still holding a payment id would
-- make the worklist disagree with the payment record.
ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_match_requires_payment_check"
  CHECK (
    ("match_status" = 'MATCHED' AND "matched_payment_id" IS NOT NULL)
    OR ("match_status" <> 'MATCHED' AND "matched_payment_id" IS NULL)
  );

-- Setting a line aside is a decision, and a decision without a reason is not reviewable.
ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_ignored_requires_note_check"
  CHECK ("match_status" <> 'IGNORED' OR btrim(coalesce("match_note", '')) <> '');

-- A matched line records when it was matched. Who did it may be null: the automatic pass
-- has no person behind it, and recording a false one would be worse than recording none.
ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_match_requires_timestamp_check"
  CHECK ("match_status" <> 'MATCHED' OR "matched_at" IS NOT NULL);

-- Money leaving the school's account — a bank charge, a transfer out — is never a
-- student's payment. Refused here as well as in the service, because the alternative is a
-- credit to a family for money the school paid away.
ALTER TABLE "bank_statement_lines"
  ADD CONSTRAINT "bank_statement_lines_only_money_in_matches_check"
  CHECK ("direction" = 'MONEY_IN' OR "matched_payment_id" IS NULL);

-- One line per payment, one payment per line.
--
-- A partial unique index rather than a column constraint, because the column is null for
-- every line nobody has attributed yet, and NULLs must stay free to repeat.
CREATE UNIQUE INDEX "bank_statement_lines_one_line_per_payment"
  ON "bank_statement_lines" ("matched_payment_id")
  WHERE "matched_payment_id" IS NOT NULL;
