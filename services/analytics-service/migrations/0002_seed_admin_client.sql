INSERT INTO "clients" ("id", "name", "secret_hash", "active")
VALUES ('admin', 'Admin UI', '', true)
ON CONFLICT ("id") DO UPDATE
SET
  "name" = EXCLUDED."name",
  "active" = EXCLUDED."active";
--> statement-breakpoint
UPDATE "clients"
SET "active" = false
WHERE "id" IN ('anonymous', 'legacy');
