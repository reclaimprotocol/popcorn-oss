import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { connectionString, databaseHostForLogs, sslMode } from './database-config';

console.log(`🔌 Connecting to PostgreSQL at ${databaseHostForLogs || 'DATABASE_URL'}...`);

const client = postgres(connectionString, {
  ssl: sslMode
});
export const db = drizzle(client, { schema });

console.log('✅ Database connection established');
