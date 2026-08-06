import type { Config } from 'drizzle-kit';
import { connectionString } from './src/database-config';

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: connectionString,
  },
} satisfies Config;
