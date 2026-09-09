import pg from 'pg';

import {
  parseDatabaseUrl,
  parseNodeEnvironment,
  safeDatabaseErrorCode,
} from '../config/database.js';

const { Pool } = pg;

export const databasePool = new Pool({
  connectionString: parseDatabaseUrl(
    parseNodeEnvironment(process.env.NODE_ENV),
    process.env.DATABASE_URL,
  ),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  query_timeout: 10_000,
});

databasePool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error.', { code: safeDatabaseErrorCode(error) });
});

export const closeDatabasePool = async (): Promise<void> => {
  await databasePool.end();
};

export const createDatabaseReadinessCheck = (
  query: () => Promise<unknown>,
  timeoutMs: number,
): (() => Promise<boolean>) => {
  let pending: Promise<boolean> | null = null;
  return async () => {
    // Keep the actual probe coalesced even when callers time out; an outage must
    // not fill every pool slot with health checks.
    pending ??= Promise.resolve()
      .then(query)
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        pending = null;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
};
