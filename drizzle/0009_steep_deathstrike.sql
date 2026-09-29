ALTER TABLE "tenants" ALTER COLUMN "settings" SET DEFAULT '{"botEnabled":true,"dailyMessageLimit":200,"businessHours":{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"},"texts":{},"allowedSearchDomains":[],"replyDelaySeconds":30,"maxReplyWaitSeconds":180,"returnsFormUrl":"","phoneCountryCode":"90"}'::jsonb;--> statement-breakpoint
UPDATE "tenants"
SET "settings" = jsonb_set(COALESCE("settings", '{}'::jsonb), '{replyDelaySeconds}', '30'::jsonb)
WHERE "settings"->>'replyDelaySeconds' IS NULL OR "settings"->>'replyDelaySeconds' = '60';
