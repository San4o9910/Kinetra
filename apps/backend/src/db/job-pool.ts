import pg from 'pg';

import { safeDatabaseErrorCode } from '../config/database.js';

export const createJobDatabasePool = (applicationName: string, databaseUrl: string): pg.Pool => {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    application_name: applicationName,
    max: 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    query_timeout: 30000,
  });
  pool.on('error', (error) =>
    console.error('Unexpected job database pool error.', { code: safeDatabaseErrorCode(error) }),
  );
  return pool;
};
