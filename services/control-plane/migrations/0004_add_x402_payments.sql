ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "allowed_clusters" jsonb;
--> statement-breakpoint
INSERT INTO "clients" ("id", "name", "secret_hash", "active")
VALUES ('x402-public', 'Public x402', '', false)
ON CONFLICT ("id") DO UPDATE
SET "name" = EXCLUDED."name", "active" = EXCLUDED."active";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "x402_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"payment_payload_hash" text,
	"operation" text NOT NULL,
	"session_id" text,
	"payer_wallet" text,
	"network" text NOT NULL,
	"asset" text,
	"amount_atomic" text NOT NULL,
	"pay_to" text NOT NULL,
	"blocks" integer NOT NULL,
	"status" text DEFAULT 'challenge_issued' NOT NULL,
	"facilitator_url" text NOT NULL,
	"transaction_hash" text,
	"failure_reason" text,
	"response" jsonb,
	"settlement_response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"settled_at" timestamp,
	CONSTRAINT "x402_payments_operation_check" CHECK ("operation" in ('create', 'extend')),
	CONSTRAINT "x402_payments_blocks_check" CHECK ("blocks" > 0),
	CONSTRAINT "x402_payments_amount_atomic_check" CHECK ("amount_atomic" ~ '^[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "x402_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"management_token_hash" text NOT NULL,
	"paid_blocks" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "x402_sessions_paid_blocks_check" CHECK ("paid_blocks" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "x402_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid,
	"session_id" text,
	"event_type" text NOT NULL,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "x402_cleanup_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"region" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "x402_cleanup_outbox_attempts_check" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "x402_operation_claims" (
	"claim_key" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"operation" text NOT NULL,
	"lease_expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "x402_settlement_outbox" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response" jsonb NOT NULL,
	"settlement_request_encrypted" text NOT NULL,
	"settlement_start_block" bigint NOT NULL,
	"recovery" jsonb,
	"settlement_response" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "x402_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "x402_sessions" ADD CONSTRAINT "x402_sessions_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "x402_events" ADD CONSTRAINT "x402_events_payment_id_x402_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."x402_payments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "x402_cleanup_outbox" ADD CONSTRAINT "x402_cleanup_outbox_payment_id_x402_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."x402_payments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "x402_settlement_outbox" ADD CONSTRAINT "x402_settlement_outbox_payment_id_x402_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."x402_payments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "x402_payments_idempotency_key_idx" ON "x402_payments" USING btree ("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "x402_payments_payload_hash_idx" ON "x402_payments" USING btree ("payment_payload_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "x402_payments_transaction_hash_idx" ON "x402_payments" USING btree ("transaction_hash");
CREATE INDEX IF NOT EXISTS "x402_payments_session_idx" ON "x402_payments" USING btree ("session_id");
CREATE INDEX IF NOT EXISTS "x402_payments_status_created_idx" ON "x402_payments" USING btree ("status", "created_at");
CREATE INDEX IF NOT EXISTS "x402_payments_payer_idx" ON "x402_payments" USING btree ("payer_wallet");
CREATE INDEX IF NOT EXISTS "x402_events_payment_idx" ON "x402_events" USING btree ("payment_id");
CREATE INDEX IF NOT EXISTS "x402_events_session_idx" ON "x402_events" USING btree ("session_id");
CREATE INDEX IF NOT EXISTS "x402_events_type_timestamp_idx" ON "x402_events" USING btree ("event_type", "timestamp");
CREATE INDEX IF NOT EXISTS "x402_cleanup_outbox_status_idx" ON "x402_cleanup_outbox" USING btree ("status", "created_at");
CREATE INDEX IF NOT EXISTS "x402_cleanup_outbox_session_idx" ON "x402_cleanup_outbox" USING btree ("session_id");
CREATE INDEX IF NOT EXISTS "x402_operation_claims_lease_idx" ON "x402_operation_claims" USING btree ("lease_expires_at");
CREATE INDEX IF NOT EXISTS "x402_settlement_outbox_status_idx" ON "x402_settlement_outbox" USING btree ("status", "created_at");
CREATE INDEX IF NOT EXISTS "x402_settlement_outbox_session_idx" ON "x402_settlement_outbox" USING btree ("session_id");
CREATE INDEX IF NOT EXISTS "x402_rate_limits_updated_idx" ON "x402_rate_limits" USING btree ("updated_at");
