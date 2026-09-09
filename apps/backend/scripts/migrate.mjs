import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { config as loadEnv } from 'dotenv';
import pg from 'pg';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(backendRoot, '../..');
const defaultMigrationsDirectory = resolve(backendRoot, 'migrations');
const localDatabaseUrl = 'postgresql://kinetra:kinetra_local_only@localhost:5432/kinetra';

const configurationError = () => {
  const error = new Error('Migration database configuration is invalid.');
  error.code = 'KINETRA_MIGRATION_CONFIGURATION';
  return error;
};

// Keep the production contract aligned with src/config/database.ts. This script
// must also run before the TypeScript application has been built.
export const parseMigrationDatabaseUrl = (environment = process.env) => {
  const nodeEnv = environment.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw configurationError();
  }

  const databaseUrl =
    environment.DATABASE_URL ?? (nodeEnv === 'production' ? undefined : localDatabaseUrl);
  if (!databaseUrl || databaseUrl.trim() !== databaseUrl) {
    throw configurationError();
  }

  let url;
  let username;
  let password;
  try {
    url = new URL(databaseUrl);
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) {
      throw configurationError();
    }
  } catch {
    throw configurationError();
  }

  if (!url.hostname || url.pathname.length <= 1) {
    throw configurationError();
  }

  if (nodeEnv === 'production') {
    let normalizedHost;
    try {
      normalizedHost = new URL(`http://${url.hostname}`).hostname;
    } catch {
      throw configurationError();
    }
    const hostname = normalizedHost.toLowerCase().replace(/\.$/u, '');
    const localHost =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      /^127(?:\.\d+){3}$/u.test(hostname) ||
      /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/u.test(hostname) ||
      ['0.0.0.0', '[::]', '[::1]', '[::ffff:0:0]'].includes(hostname);
    const sslModes = url.searchParams.getAll('sslmode');
    const unsupportedOption = [...url.searchParams.keys()].some(
      (key) => !['sslmode', 'application_name'].includes(key),
    );
    if (
      localHost ||
      !username.trim() ||
      !password.trim() ||
      password === 'kinetra_local_only' ||
      sslModes.length !== 1 ||
      !['require', 'verify-full'].includes(sslModes[0]) ||
      unsupportedOption
    ) {
      throw configurationError();
    }
  }

  return databaseUrl;
};

export const migrationFailureSummary = (error) => {
  const code = error?.code;
  const knownCodes = new Set([
    'KINETRA_MIGRATION_CONFIGURATION',
    'KINETRA_MIGRATION_CHECKSUM',
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ]);
  const safeCode =
    typeof code === 'string' && (knownCodes.has(code) || /^[0-9][A-Z0-9]{4}$/u.test(code))
      ? code
      : 'UNKNOWN';
  return `Migration runner failed (${safeCode}).`;
};

// Pool injection allows failure-path tests without opening a database connection.
export const runMigrations = async ({
  pool,
  migrationsDirectory = defaultMigrationsDirectory,
  log = console.log,
}) => {
  let client;
  let lockAcquired = false;
  let failure;
  const onClientError = (error) => {
    failure ??= error;
  };

  try {
    client = await pool.connect();
    client.on('error', onClientError);
    // Session limits protect the schema lock, while transaction-local limits
    // also cover each migration even if previous SQL changed a session setting.
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET idle_in_transaction_session_timeout = '60s'");
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['kinetra-schema-migrations']);
    lockAcquired = true;
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
          const error = new Error('An applied migration checksum changed.');
          error.code = 'KINETRA_MIGRATION_CHECKSUM';
          throw error;
        }

        log(`SKIP ${filename}`);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL statement_timeout = '60s'");
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          filename,
          checksum,
        ]);
        await client.query('COMMIT');
        log(`APPLY ${filename}`);
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original migration error, not a cleanup symptom.
        }
        throw error;
      }
    }
  } catch (error) {
    failure ??= error;
  } finally {
    if (client) {
      if (lockAcquired) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
            'kinetra-schema-migrations',
          ]);
        } catch (error) {
          failure ??= error;
        }
      }
      try {
        // Destroy errored connections so a failed ROLLBACK or unlock cannot
        // return a transaction or schema lock to the pool.
        client.release(failure !== undefined);
      } catch (error) {
        failure ??= error;
      } finally {
        client.removeListener('error', onClientError);
      }
    }
    try {
      await pool.end();
    } catch (error) {
      failure ??= error;
    }
  }

  if (failure !== undefined) {
    throw failure;
  }
};

const main = async () => {
  if (process.env.NODE_ENV !== 'production') {
    loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true });
  }
  const databaseUrl = parseMigrationDatabaseUrl();
  const { Pool } = pg;
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: 75_000,
    application_name: 'kinetra-schema-migrations',
  });
  pool.on('error', () => {
    console.error('Migration database connection failed.');
    process.exitCode = 1;
  });
  await runMigrations({ pool });
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(migrationFailureSummary(error));
    process.exitCode = 1;
  }
}
