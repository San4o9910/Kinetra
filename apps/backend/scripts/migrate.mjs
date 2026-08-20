import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import pg from 'pg';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(backendRoot, '../..');
const migrationsDirectory = resolve(backendRoot, 'migrations');

loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true });

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://kinetra:kinetra_local_only@localhost:5432/kinetra';
const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', ['kinetra-schema-migrations']);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => /^\d+_.+\.sql$/u.test(filename))
    .sort((left, right) => left.localeCompare(right));

  for (const filename of filenames) {
    const sql = await readFile(resolve(migrationsDirectory, filename), 'utf8');
    const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
    const existing = await client.query(
      'SELECT checksum FROM schema_migrations WHERE filename = $1',
      [filename],
    );

    if (existing.rowCount === 1) {
      if (existing.rows[0]?.checksum !== checksum) {
        throw new Error(`Applied migration ${filename} was modified.`);
      }

      console.log(`SKIP ${filename}`);
      continue;
    }

    await client.query('BEGIN');

    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, checksum],
      );
      await client.query('COMMIT');
      console.log(`APPLY ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
      'kinetra-schema-migrations',
    ]);
  } finally {
    client.release();
    await pool.end();
  }
}
