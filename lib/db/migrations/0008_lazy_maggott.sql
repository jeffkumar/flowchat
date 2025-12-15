CREATE TABLE IF NOT EXISTS "Project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"createdBy" uuid NOT NULL,
	"organizationId" uuid,
	"isDefault" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ProjectDoc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"createdBy" uuid NOT NULL,
	"organizationId" uuid,
	"blobUrl" text NOT NULL,
	"filename" text NOT NULL,
	"mimeType" text NOT NULL,
	"sizeBytes" bigint NOT NULL,
	"turbopufferNamespace" text,
	"indexedAt" timestamp,
	"indexingError" text,
	"createdAt" timestamp NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "Project" ADD CONSTRAINT "Project_createdBy_User_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ProjectDoc" ADD CONSTRAINT "ProjectDoc_projectId_Project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ProjectDoc" ADD CONSTRAINT "ProjectDoc_createdBy_User_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_default_per_user" ON "Project" USING btree ("createdBy") WHERE "Project"."isDefault" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_name_per_user" ON "Project" USING btree ("createdBy","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_doc_created_by_idx" ON "ProjectDoc" USING btree ("createdBy");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_doc_project_id_idx" ON "ProjectDoc" USING btree ("projectId");