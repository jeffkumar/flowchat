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
CREATE INDEX IF NOT EXISTS "integration_connection_user_provider_idx" ON "IntegrationConnection" USING btree ("userId","provider");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_connection_provider_account_unique" ON "IntegrationConnection" USING btree ("provider","tenantId","providerAccountId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_integration_source_project_idx" ON "ProjectIntegrationSource" USING btree ("projectId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_integration_source_created_by_idx" ON "ProjectIntegrationSource" USING btree ("createdBy");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
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


