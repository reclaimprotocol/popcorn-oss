import { PostgresStore } from '../src/postgres-store';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const store = PostgresStore.fromUrl(url);
await store.migrate();
console.log('mcp-server schema is up to date');
process.exit(0);
