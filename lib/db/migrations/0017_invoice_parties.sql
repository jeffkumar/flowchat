ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "sender" text;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "recipient" text;

UPDATE "invoices"
SET "sender" = "vendor"
WHERE "sender" IS NULL
  AND "vendor" IS NOT NULL;



