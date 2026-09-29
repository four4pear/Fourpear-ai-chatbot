CREATE TABLE "text_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hash" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "text_archive" ADD CONSTRAINT "text_archive_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "text_archive_ref_idx" ON "text_archive" USING btree ("tenant_id","kind","ref","first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "text_archive_current_idx" ON "text_archive" USING btree ("tenant_id","kind","ref") WHERE "text_archive"."ended_at" is null;