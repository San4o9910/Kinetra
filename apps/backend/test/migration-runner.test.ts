import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

interface QueryResult {
  readonly rowCount: number;
  readonly rows: readonly { readonly checksum: string }[];
}

interface MigrationClient extends EventEmitter {
  query(sql: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(destroy: boolean): void;
}

interface MigrationPool {
  connect(): Promise<MigrationClient>;
  end(): Promise<void>;
}

interface MigrationModule {
  parseMigrationDatabaseUrl(environment: NodeJS.ProcessEnv): string;
  migrationFailureSummary(error: unknown): string;
  runMigrations(options: {
    pool: MigrationPool;
    migrationsDirectory: string;
    log: (message: string) => void;
  }): Promise<void>;
}

const scriptUrl = new URL('../scripts/migrate.mjs', import.meta.url).href;
const { parseMigrationDatabaseUrl, migrationFailureSummary, runMigrations } = (await import(
  scriptUrl
)) as MigrationModule;

const fixtureSql = 'SELECT 7;';
const fixtureName = '001_example.sql';
const fixtureChecksum = createHash('sha256').update(fixtureSql).digest('hex');

const fakePool = (
  options: {
    connectFailure?: Error;
    queryFailure?: (sql: string) => Error | undefined;
    releaseFailure?: Error;
    endFailure?: Error;
    appliedChecksum?: string;
  } = {},
) => {
  const queries: string[] = [];
  const recordedChecksums: unknown[][] = [];
  const releases: boolean[] = [];
  let ended = false;
  const client: MigrationClient = Object.assign(new EventEmitter(), {
    async query(sql: string, values?: readonly unknown[]): Promise<QueryResult> {
      queries.push(sql);
      const failure = options.queryFailure?.(sql);
      if (failure) {
        throw failure;
      }
      if (sql.startsWith('SELECT checksum') && options.appliedChecksum) {
        return { rowCount: 1, rows: [{ checksum: options.appliedChecksum }] };
      }
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        recordedChecksums.push([...(values ?? [])]);
      }
      return { rowCount: 0, rows: [] };
    },
    release(destroy: boolean) {
      releases.push(destroy);
      if (options.releaseFailure) {
        throw options.releaseFailure;
      }
    },
  });
  const pool: MigrationPool = {
    async connect() {
      if (options.connectFailure) {
        throw options.connectFailure;
      }
      return client;
    },
    async end() {
      ended = true;
      if (options.endFailure) {
        throw options.endFailure;
      }
    },
  };
  return { pool, queries, recordedChecksums, releases, ended: () => ended };
};

const migrationFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kinetra-migration-unit-'));
  await writeFile(join(directory, fixtureName), fixtureSql);
  return directory;
};

test('migration production URL requires explicit remote credentials and a single TLS mode', () => {
  const valid = 'postgresql://migrator:p%40ssword@db.example.com/kinetra?sslmode=verify-full';
  assert.equal(parseMigrationDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: valid }), valid);
  assert.match(parseMigrationDatabaseUrl({ NODE_ENV: 'test' }), /localhost/u);
  assert.throws(() => parseMigrationDatabaseUrl({ NODE_ENV: 'production' }));
  assert.throws(() => parseMigrationDatabaseUrl({ NODE_ENV: 'prod', DATABASE_URL: valid }));
  for (const databaseUrl of [
    '',
    `${valid} `,
    'https://migrator:password@db.example.com/kinetra?sslmode=require',
    'postgresql://migrator:password@db.example.com/?sslmode=require',
    'postgresql://db.example.com/kinetra?sslmode=require',
    'postgresql://migrator@db.example.com/kinetra?sslmode=require',
    'postgresql://migrator:kinetra_local_only@db.example.com/kinetra?sslmode=require',
    'postgresql://migrator:password@db.example.com/kinetra',
    'postgresql://migrator:password@db.example.com/kinetra?sslmode=disable',
    `${valid}&sslmode=require`,
    `${valid}&ssl=false`,
    `${valid}&sslcert=/private/certificate.pem`,
    `${valid}&options=-c%20statement_timeout%3D0`,
    `${valid}#fragment`,
    ...[
      'localhost',
      'api.localhost',
      'localhost.',
      '127.0.0.1',
      '127.0.0.2',
      '127.1',
      '2130706433',
      '0x7f000001',
      '[::ffff:127.0.0.1]',
      '0.0.0.0',
      '[::1]',
      '[::]',
    ].map((host) => `postgresql://migrator:password@${host}/kinetra?sslmode=require`),
  ]) {
    assert.throws(
      () => parseMigrationDatabaseUrl({ NODE_ENV: 'production', DATABASE_URL: databaseUrl }),
      /configuration is invalid/u,
    );
  }
});

test('migration runner commits new SQL with its checksum and leaves applied SQL unchanged', async (t) => {
  const directory = await migrationFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const messages: string[] = [];
  const fresh = fakePool();
  await runMigrations({
    pool: fresh.pool,
    migrationsDirectory: directory,
    log: (message) => messages.push(message),
  });
  assert.deepEqual(fresh.recordedChecksums, [[fixtureName, fixtureChecksum]]);
  assert.ok(fresh.queries.indexOf('BEGIN') < fresh.queries.indexOf(fixtureSql));
  assert.ok(fresh.queries.indexOf(fixtureSql) < fresh.queries.indexOf('COMMIT'));
  assert.ok(
    fresh.queries.indexOf("SET lock_timeout = '5s'") <
      fresh.queries.findIndex((sql) => sql.includes('pg_advisory_lock')),
  );
  assert.ok(fresh.queries.includes("SET LOCAL statement_timeout = '60s'"));
  assert.ok(fresh.queries.includes("SET LOCAL idle_in_transaction_session_timeout = '60s'"));
  assert.equal(fresh.queries.filter((sql) => sql.includes('pg_advisory_unlock')).length, 1);
  assert.deepEqual(fresh.releases, [false]);
  assert.equal(fresh.ended(), true);
  assert.deepEqual(messages, [`APPLY ${fixtureName}`]);

  const applied = fakePool({ appliedChecksum: fixtureChecksum });
  await runMigrations({
    pool: applied.pool,
    migrationsDirectory: directory,
    log: (message) => messages.push(message),
  });
  assert.equal(applied.queries.includes('BEGIN'), false);
  assert.equal(applied.queries.includes(fixtureSql), false);
  assert.deepEqual(applied.recordedChecksums, []);
  assert.equal(messages.at(-1), `SKIP ${fixtureName}`);
});

test('migration runner rejects a changed applied migration before executing SQL', async (t) => {
  const directory = await migrationFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = fakePool({ appliedChecksum: 'different-checksum' });
  await assert.rejects(
    runMigrations({ pool: fake.pool, migrationsDirectory: directory, log: () => {} }),
    { code: 'KINETRA_MIGRATION_CHECKSUM' },
  );
  assert.equal(fake.queries.includes('BEGIN'), false);
  assert.equal(fake.queries.includes(fixtureSql), false);
  assert.deepEqual(fake.releases, [true]);
  assert.equal(fake.ended(), true);
});

test('migration runner closes its pool after a failed connection and preserves that failure', async () => {
  const failure = new Error('connect failed');
  const fake = fakePool({ connectFailure: failure, endFailure: new Error('close failed') });
  await assert.rejects(
    runMigrations({ pool: fake.pool, migrationsDirectory: '/unused', log: () => {} }),
    (error) => error === failure,
  );
  assert.deepEqual(fake.queries, []);
  assert.deepEqual(fake.releases, []);
  assert.equal(fake.ended(), true);
});

test('migration runner never unlocks an advisory lock it failed to acquire', async () => {
  const failure = new Error('lock timeout');
  const fake = fakePool({
    queryFailure: (sql) => (sql.includes('pg_advisory_lock') ? failure : undefined),
  });
  await assert.rejects(
    runMigrations({ pool: fake.pool, migrationsDirectory: '/unused', log: () => {} }),
    (error) => error === failure,
  );
  assert.equal(
    fake.queries.some((sql) => sql.includes('pg_advisory_unlock')),
    false,
  );
  assert.deepEqual(fake.releases, [true]);
  assert.equal(fake.ended(), true);
});

test('migration SQL failure survives rollback, unlock, release and pool-close failures', async (t) => {
  const directory = await migrationFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = new Error('original SQL failure');
  const fake = fakePool({
    queryFailure: (sql) => {
      if (sql === fixtureSql) return original;
      if (sql === 'ROLLBACK' || sql.includes('pg_advisory_unlock'))
        return new Error('cleanup failed');
      return undefined;
    },
    releaseFailure: new Error('release failed'),
    endFailure: new Error('close failed'),
  });
  await assert.rejects(
    runMigrations({ pool: fake.pool, migrationsDirectory: directory, log: () => {} }),
    (error) => error === original,
  );
  assert.equal(fake.queries.includes('ROLLBACK'), true);
  assert.equal(fake.queries.includes('COMMIT'), false);
  assert.deepEqual(fake.recordedChecksums, []);
  assert.deepEqual(fake.releases, [true]);
  assert.equal(fake.ended(), true);
});

test('migration runner reports cleanup failure even when SQL succeeded', async (t) => {
  const directory = await migrationFixture();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failure = new Error('unlock failed');
  const fake = fakePool({
    queryFailure: (sql) => (sql.includes('pg_advisory_unlock') ? failure : undefined),
  });
  await assert.rejects(
    runMigrations({ pool: fake.pool, migrationsDirectory: directory, log: () => {} }),
    (error) => error === failure,
  );
  assert.equal(fake.queries.includes('COMMIT'), true);
  assert.deepEqual(fake.releases, [true]);
  assert.equal(fake.ended(), true);
});

test('migration CLI summaries do not disclose driver messages, SQL, URLs or arbitrary codes', () => {
  const secret = 'postgresql://secret-user:secret-password@private.internal/kinetra';
  assert.equal(
    migrationFailureSummary({ code: '23505', message: secret, detail: 'SELECT secret_token' }),
    'Migration runner failed (23505).',
  );
  assert.equal(
    migrationFailureSummary({ code: secret, message: secret }),
    'Migration runner failed (UNKNOWN).',
  );
  assert.equal(migrationFailureSummary(new Error(secret)), 'Migration runner failed (UNKNOWN).');
});
