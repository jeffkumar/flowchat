-- Extend ProjectDoc with typed ingest/parse metadata
ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "documentType" varchar
    DEFAULT 'general_doc' NOT NULL;

ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "parseStatus" varchar
    DEFAULT 'pending' NOT NULL;

ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "parseError" text;

ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "extractedJsonBlobUrl" text;

ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "schemaId" text;

ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "schemaVersion" bigint;

ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "currency" text;

ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "periodStart" date;

ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "periodEnd" date;

ALTER TABLE "ProjectDoc"
  ADD COLUMN IF NOT EXISTS "accountHint" text;

CREATE INDEX IF NOT EXISTS "project_doc_document_type_idx"
  ON "ProjectDoc" USING btree ("projectId", "documentType");

CREATE INDEX IF NOT EXISTS "project_doc_parse_status_idx"
  ON "ProjectDoc" USING btree ("parseStatus");

-- Normalized finance tables
CREATE TABLE IF NOT EXISTS "financial_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL,
  "txn_date" date NOT NULL,
  "description" text,
  "amount" numeric(14,2) NOT NULL,
  "currency" text,
  "merchant" text,
  "category" text,
  "balance" numeric(14,2),
  "page_num" bigint,
  "row_num" bigint,
  "row_hash" text NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "financial_transactions"
    ADD CONSTRAINT "financial_transactions_document_id_fk"
    FOREIGN KEY ("document_id") REFERENCES "public"."ProjectDoc"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "ft_doc_idx"
  ON "financial_transactions" USING btree ("document_id");

CREATE INDEX IF NOT EXISTS "ft_date_idx"
  ON "financial_transactions" USING btree ("txn_date");

CREATE UNIQUE INDEX IF NOT EXISTS "ft_doc_hash_unique"
  ON "financial_transactions" USING btree ("document_id", "row_hash");

CREATE TABLE IF NOT EXISTS "invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "document_id" uuid NOT NULL UNIQUE,
  "vendor" text,
  "invoice_number" text,
  "invoice_date" date,
  "due_date" date,
  "subtotal" numeric(14,2),
  "tax" numeric(14,2),
  "total" numeric(14,2),
  "currency" text
);

DO $$ BEGIN
  ALTER TABLE "invoices"
    ADD CONSTRAINT "invoices_document_id_fk"
    FOREIGN KEY ("document_id") REFERENCES "public"."ProjectDoc"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "invoices_document_id_unique"
  ON "invoices" USING btree ("document_id");

CREATE TABLE IF NOT EXISTS "invoice_line_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "invoice_id" uuid NOT NULL,
  "description" text,
  "quantity" numeric(14,4),
  "unit_price" numeric(14,4),
  "amount" numeric(14,2),
  "row_hash" text NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "invoice_line_items"
    ADD CONSTRAINT "invoice_line_items_invoice_id_fk"
    FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id")
    ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "ili_invoice_idx"
  ON "invoice_line_items" USING btree ("invoice_id");

CREATE UNIQUE INDEX IF NOT EXISTS "ili_inv_hash_unique"
  ON "invoice_line_items" USING btree ("invoice_id", "row_hash");


