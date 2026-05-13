INSERT INTO "clients" ("id", "name", "secret_hash", "active")
VALUES
  ('anonymous', 'Anonymous (No Auth)', '', true),
  ('legacy', 'Legacy API Token', '', true)
ON CONFLICT ("id") DO UPDATE
SET
  "name" = EXCLUDED."name",
  "active" = EXCLUDED."active";
