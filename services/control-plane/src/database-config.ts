import { readFileSync } from 'node:fs';

const DATABASE_SSL = (process.env.DATABASE_SSL || 'false').trim().toLowerCase();
const DATABASE_SSL_CA = process.env.DATABASE_SSL_CA?.trim();
const DATABASE_SSL_CA_FILE = process.env.DATABASE_SSL_CA_FILE?.trim();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getConnectionConfig() {
  const DATABASE_URL = process.env.DATABASE_URL?.trim();

  if (DATABASE_URL) {
    const hostForLogs = new URL(DATABASE_URL).hostname;
    return {
      connectionString: DATABASE_URL,
      databaseHostForLogs: hostForLogs || 'DATABASE_URL',
    };
  }

  const POSTGRES_HOST = requireEnv('POSTGRES_HOST');
  const POSTGRES_PORT = process.env.POSTGRES_PORT || '5432';
  const POSTGRES_USER = requireEnv('POSTGRES_USER');
  const POSTGRES_PASSWORD = requireEnv('POSTGRES_PASSWORD');
  const POSTGRES_DB = process.env.POSTGRES_DB || 'analytics';

  const hostname = POSTGRES_HOST.split(':')[0];
  const encodedUser = encodeURIComponent(POSTGRES_USER);
  const encodedPassword = encodeURIComponent(POSTGRES_PASSWORD);

  return {
    connectionString: `postgresql://${encodedUser}:${encodedPassword}@${hostname}:${POSTGRES_PORT}/${POSTGRES_DB}`,
    databaseHostForLogs: POSTGRES_HOST,
  };
}

const { connectionString, databaseHostForLogs } = getConnectionConfig();

export const sslMode = (() => {
  if (DATABASE_SSL === 'true' || DATABASE_SSL === 'require') {
    return 'require';
  }

  if (DATABASE_SSL === 'verify-full') {
    const ca = getDatabaseSslCa();

    if (!ca) {
      return { rejectUnauthorized: true };
    }

    return {
      rejectUnauthorized: true,
      ca,
    };
  }

  return false;
})();

function getDatabaseSslCa() {
  if (DATABASE_SSL_CA_FILE) {
    return readFileSync(DATABASE_SSL_CA_FILE, 'utf8');
  }

  return DATABASE_SSL_CA;
}

export { connectionString, databaseHostForLogs };
