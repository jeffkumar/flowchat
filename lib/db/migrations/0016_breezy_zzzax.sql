CREATE TABLE IF NOT EXISTS "financial_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"txn_date" date NOT NULL,
	"description" text,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text,
	"merchant" text,
	"category" text,
	"balance" numeric(14, 2),
	"page_num" bigint,
	"row_num" bigint,
	"row_hash" text NOT NULL,
	"txn_hash" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "IntegrationConnection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"provider" varchar NOT NULL,
	"accountEmail" text,
	"providerAccountId" text,
	"tenantId" text,
	"scopes" jsonb NOT NULL,
	"accessTokenEnc" text,
	"refreshTokenEnc" text,
	"expiresAt" timestamp,
	"revokedAt" timestamp,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"vendor" text,
	"sender" text,
	"recipient" text,
	"invoice_number" text,
	"invoice_date" date,
	"due_date" date,
	"subtotal" numeric(14, 2),
	"tax" numeric(14, 2),
	"total" numeric(14, 2),
	"currency" text,
	CONSTRAINT "invoices_document_id_unique" UNIQUE("document_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"description" text,
	"quantity" numeric(14, 4),
	"unit_price" numeric(14, 4),
	"amount" numeric(14, 2),
	"row_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ProjectIntegrationSource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"createdBy" uuid NOT NULL,
	"provider" varchar NOT NULL,
	"resourceType" varchar NOT NULL,
	"siteId" text,
	"driveId" text,
	"itemId" text,
	"syncEnabled" boolean DEFAULT false NOT NULL,
	"cursor" text,
	"createdAt" timestamp NOT NULL,
	"updatedAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ProjectInvitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"email" varchar NOT NULL,
	"role" varchar NOT NULL,
	"invitedBy" uuid NOT NULL,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ProjectUser" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"userId" uuid NOT NULL,
	"role" varchar NOT NULL,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "category" text;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "documentType" varchar DEFAULT 'general_doc' NOT NULL;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "parseStatus" varchar DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "parseError" text;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "extractedJsonBlobUrl" text;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "schemaId" text;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "schemaVersion" bigint;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "currency" text;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "periodStart" date;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "periodEnd" date;--> statement-breakpoint
ALTER TABLE "ProjectDoc" ADD COLUMN IF NOT EXISTS "accountHint" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_document_id_ProjectDoc_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."ProjectDoc"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_document_id_ProjectDoc_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."ProjectDoc"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ProjectIntegrationSource" ADD CONSTRAINT "ProjectIntegrationSource_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ProjectIntegrationSource" ADD CONSTRAINT "ProjectIntegrationSource_createdBy_User_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ProjectInvitation" ADD CONSTRAINT "ProjectInvitation_invitedBy_User_id_fk" FOREIGN KEY ("invitedBy") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ProjectUser" ADD CONSTRAINT "ProjectUser_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ProjectUser" ADD CONSTRAINT "ProjectUser_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ft_doc_idx" ON "financial_transactions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ft_date_idx" ON "financial_transactions" USING btree ("txn_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ft_txn_hash_idx" ON "financial_transactions" USING btree ("txn_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ft_doc_hash_unique" ON "financial_transactions" USING btree ("document_id","row_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_connection_user_provider_idx" ON "IntegrationConnection" USING btree ("userId","provider");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_connection_provider_account_unique" ON "IntegrationConnection" USING btree ("provider","tenantId","providerAccountId");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_document_id_unique" ON "invoices" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ili_invoice_idx" ON "invoice_line_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ili_inv_hash_unique" ON "invoice_line_items" USING btree ("invoice_id","row_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_integration_source_project_idx" ON "ProjectIntegrationSource" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_integration_source_created_by_idx" ON "ProjectIntegrationSource" USING btree ("createdBy");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_invitation_idx" ON "ProjectInvitation" USING btree ("projectId","email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_user_idx" ON "ProjectUser" USING btree ("projectId","userId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_doc_document_type_idx" ON "ProjectDoc" USING btree ("projectId","documentType");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_doc_parse_status_idx" ON "ProjectDoc" USING btree ("parseStatus");