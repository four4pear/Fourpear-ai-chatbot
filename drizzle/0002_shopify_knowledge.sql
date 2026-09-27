CREATE TABLE "knowledge_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid,
	"topic" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"content" text NOT NULL,
	"kind" text NOT NULL,
	"auto_enabled" boolean NOT NULL,
	"enabled_override" boolean,
	"shopify_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shop_domain" text NOT NULL,
	"scopes" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_enc" text,
	"refresh_token_expires_at" timestamp with time zone,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uninstalled_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_sync_error" text,
	CONSTRAINT "shopify_stores_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "shopify_stores_shop_domain_unique" UNIQUE("shop_domain")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_alerts" ADD CONSTRAINT "knowledge_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_alerts" ADD CONSTRAINT "knowledge_alerts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_docs" ADD CONSTRAINT "knowledge_docs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_stores" ADD CONSTRAINT "shopify_stores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_alerts_tenant_idx" ON "knowledge_alerts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_docs_source_idx" ON "knowledge_docs" USING btree ("tenant_id","source","external_id");