CREATE TABLE IF NOT EXISTS "WaitlistRequest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(64) NOT NULL,
	"password" varchar(64),
	"businessName" varchar(255) NOT NULL,
	"phoneNumber" varchar(20) NOT NULL,
	"address" text NOT NULL,
	"country" varchar(100) NOT NULL,
	"state" varchar(100),
	"status" varchar NOT NULL DEFAULT 'pending',
	"createdAt" timestamp NOT NULL,
	"approvedAt" timestamp,
	"approvedBy" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_request_email_idx" ON "WaitlistRequest" ("email");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "WaitlistRequest" ADD CONSTRAINT "WaitlistRequest_approvedBy_User_id_fk" FOREIGN KEY ("approvedBy") REFERENCES "public"."User"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
