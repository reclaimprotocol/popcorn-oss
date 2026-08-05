ALTER TABLE "x402_sessions"
RENAME COLUMN "management_token_hash" TO "capability_hash";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "x402_sessions_capability_hash_idx"
ON "x402_sessions" ("capability_hash");
--> statement-breakpoint
ALTER TABLE "x402_payments"
ADD COLUMN IF NOT EXISTS "payment_signature_hash" text;
