-- Add cross-document transaction hash for deduplicating overlapping statement docs

-- gen_random_uuid() is already used in earlier migrations; pgcrypto should exist, but keep this safe.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "financial_transactions"
  ADD COLUMN IF NOT EXISTS "txn_hash" text;

CREATE INDEX IF NOT EXISTS "ft_txn_hash_idx"
  ON "financial_transactions" USING btree ("txn_hash");

-- Backfill txn_hash for existing rows.
-- Normalization mirrors app-side ingestion:
-- - txn_date: YYYY-MM-DD (date::text)
-- - amount/balance: 2dp fixed string
-- - description: trim + collapse whitespace + lower
UPDATE "financial_transactions"
SET "txn_hash" = encode(
  digest(
    (
      "txn_date"::text
      || '|' || to_char("amount", 'FM999999999999990.00')
      || '|' || lower(regexp_replace(trim(coalesce("description", '')), '\\s+', ' ', 'g'))
      || '|' || coalesce(to_char("balance", 'FM999999999999990.00'), '')
    )::text,
    'sha256'
  ),
  'hex'
)
WHERE "txn_hash" IS NULL;


