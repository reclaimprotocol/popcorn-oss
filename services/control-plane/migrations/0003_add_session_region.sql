ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "region" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_region_idx" ON "sessions" USING btree ("region");
