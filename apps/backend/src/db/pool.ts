import pg from 'pg';

import { env } from '../config/env.js';

const { Pool } = pg;

export const databasePool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

databasePool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error.', error);
});

export const closeDatabasePool = async (): Promise<void> => {
  await databasePool.end();
};
