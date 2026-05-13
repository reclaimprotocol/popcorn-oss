import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { connectionString, databaseHostForLogs, sslMode } from './database-config';

const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../migrations');
const MAX_CONNECTION_RETRIES = 30;
const CONNECTION_RETRY_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(db: ReturnType<typeof drizzle>) {
  for (let attempt = 1; attempt <= MAX_CONNECTION_RETRIES; attempt += 1) {
    try {
      await db.execute(sql`select 1`);
      return;
    } catch (error) {
      if (attempt === MAX_CONNECTION_RETRIES) {
        throw error;
      }

      console.warn(
        `⏳ PostgreSQL not ready at ${databaseHostForLogs || 'DATABASE_URL'} ` +
        `(attempt ${attempt}/${MAX_CONNECTION_RETRIES})`,
      );
      await sleep(CONNECTION_RETRY_DELAY_MS);
    }
  }
}

async function runMigrations() {
  const client = postgres(connectionString, {
    max: 1,
    ssl: sslMode,
  });
  const db = drizzle(client);

  try {
    console.log(`🔧 Running Drizzle migrations against ${databaseHostForLogs || 'DATABASE_URL'}...`);
    await waitForDatabase(db);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    console.log('✅ Drizzle migrations complete');
  } finally {
    await client.end();
  }
}

await runMigrations();
