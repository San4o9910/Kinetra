import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

interface SeedClient extends EventEmitter {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}
interface SeedPool {
  connect(): Promise<SeedClient>;
  end(): Promise<void>;
}
interface SeedModule {
  validateSeedArguments(nodeEnv: string, args: string[]): void;
  contentSeedFailureSummary(error: unknown): string;
  runContentSeed(options: {
    pool: SeedPool;
    initialEmptyDatabase?: boolean;
    log?: (message: string) => void;
  }): Promise<void>;
}

const scriptUrl = new URL('../scripts/seed.mjs', import.meta.url);
const { validateSeedArguments, contentSeedFailureSummary, runContentSeed } = (await import(
  scriptUrl.href
)) as SeedModule;
const expectedCounts = {
  program_weeks: 12,
  program_days: 84,
  base_lessons: 7,
  workouts: 84,
  achievements: 5,
};

function fakePool(
  options: {
    occupied?: boolean;
    connectFailure?: Error;
    queryFailure?: (sql: string) => Error | undefined;
    releaseFailure?: Error;
    endFailure?: Error;
  } = {},
) {
  const queries: string[] = [];
  const releases: boolean[] = [];
  let ended = false;
  const client: SeedClient = Object.assign(new EventEmitter(), {
    async query(sql: string) {
      queries.push(sql);
      const failure = options.queryFailure?.(sql);
      if (failure) throw failure;
      if (sql.includes('AS occupied')) return { rows: [{ occupied: options.occupied ?? false }] };
      if (sql.includes('RETURNING id')) return { rows: [{ id: randomUUID() }] };
      if (sql.includes('AS program_weeks')) return { rows: [expectedCounts] };
      return { rows: [] };
    },
    release(destroy = false) {
      releases.push(destroy);
      if (options.releaseFailure) throw options.releaseFailure;
    },
  });
  const pool: SeedPool = {
    async connect() {
      if (options.connectFailure) throw options.connectFailure;
      return client;
    },
    async end() {
      ended = true;
      if (options.endFailure) throw options.endFailure;
    },
  };
  return { pool, queries, releases, ended: () => ended };
}

test('content seed unit: production requires exactly the explicit initial-empty flag', () => {
  validateSeedArguments('production', ['--initial-empty-database']);
  validateSeedArguments('development', []);
  validateSeedArguments('test', []);
  for (const args of [
    [],
    ['--force'],
    ['--initial-empty-database', '--force'],
    ['--initial-empty-database', '--initial-empty-database'],
  ]) {
    assert.throws(() => validateSeedArguments('production', args), {
      code: 'KINETRA_CONTENT_SEED_CONFIGURATION',
    });
  }
  assert.throws(() => validateSeedArguments('prod', []));
  assert.throws(() => validateSeedArguments('test', ['--initial-empty-database']));
  const result = spawnSync(process.execPath, [fileURLToPath(scriptUrl)], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: 'must-not-be-connected-or-printed',
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Content seed failed (KINETRA_CONTENT_SEED_CONFIGURATION).');
});

test('content seed unit: dotenv cannot turn a local seed into unguarded production writes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kinetra-content-seed-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = join(directory, 'apps/backend/scripts');
  await mkdir(scripts, { recursive: true });
  await copyFile(scriptUrl, join(scripts, 'seed.mjs'));
  await symlink(
    fileURLToPath(new URL('../../../node_modules', import.meta.url)),
    join(directory, 'node_modules'),
    'dir',
  );
  await writeFile(
    join(directory, '.env'),
    'NODE_ENV=production\nDATABASE_URL=postgresql://synthetic:private-fixture@unreachable.invalid/kinetra?sslmode=verify-full\n',
  );
  const environment = { ...process.env };
  delete environment.NODE_ENV;
  delete environment.DATABASE_URL;
  const result = spawnSync(process.execPath, [join(scripts, 'seed.mjs')], {
    env: environment,
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'Content seed failed (KINETRA_CONTENT_SEED_CONFIGURATION).');
});

test('content seed unit: nonempty refusal precedes writes and releases every resource', async () => {
  const fake = fakePool({ occupied: true });
  const messages: string[] = [];
  await assert.rejects(
    runContentSeed({
      pool: fake.pool,
      initialEmptyDatabase: true,
      log: (message) => messages.push(message),
    }),
    { code: 'KINETRA_CONTENT_SEED_NOT_EMPTY' },
  );
  assert.equal(
    fake.queries.some((sql) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/u.test(sql)),
    false,
  );
  assert.equal(fake.queries.includes('COMMIT'), false);
  assert.equal(fake.queries.at(-1), 'ROLLBACK');
  assert.deepEqual(fake.releases, [true]);
  assert.equal(fake.ended(), true);
  assert.deepEqual(messages, []);
});

test('content seed unit: connection and transaction failures preserve the original error', async () => {
  const original = new Error('private credentials and SQL must never be logged');
  for (const options of [
    { connectFailure: original, endFailure: new Error('end failure') },
    {
      queryFailure: (sql: string) =>
        sql.includes('pg_advisory_xact_lock')
          ? original
          : sql === 'ROLLBACK'
            ? new Error('rollback failure')
            : undefined,
      releaseFailure: new Error('release failure'),
      endFailure: new Error('end failure'),
    },
    {
      queryFailure: (sql: string) =>
        sql.includes('INSERT INTO program_days') ? original : undefined,
    },
  ]) {
    const fake = fakePool(options);
    const messages: string[] = [];
    await assert.rejects(
      runContentSeed({
        pool: fake.pool,
        initialEmptyDatabase: true,
        log: (message) => messages.push(message),
      }),
      (error) => error === original,
    );
    assert.equal(fake.ended(), true);
    assert.deepEqual(messages, []);
  }
  assert.equal(contentSeedFailureSummary(original), 'Content seed failed (UNKNOWN).');
  assert.equal(
    contentSeedFailureSummary({ code: 'SECRET_API_KEY_123' }),
    'Content seed failed (UNKNOWN).',
  );
  assert.equal(contentSeedFailureSummary({ code: '55P03' }), 'Content seed failed (55P03).');
});

test('content seed unit: successful cleanup precedes PASS and development keeps idempotent upserts', async () => {
  for (const initialEmptyDatabase of [true, false]) {
    const fake = fakePool();
    const messages: string[] = [];
    await runContentSeed({
      pool: fake.pool,
      initialEmptyDatabase,
      log: (message) => {
        assert.equal(fake.ended(), true);
        messages.push(message);
      },
    });
    assert.equal(fake.queries.includes('COMMIT'), true);
    assert.equal(
      fake.queries.some((sql) => sql.includes('AS occupied')),
      initialEmptyDatabase,
    );
    assert.deepEqual(fake.releases, [false]);
    assert.deepEqual(messages, ['KINETRA_CONTENT_SEED=PASS', JSON.stringify(expectedCounts)]);
  }
  const failedClose = fakePool({ endFailure: new Error('pool close failed') });
  const messages: string[] = [];
  await assert.rejects(
    runContentSeed({
      pool: failedClose.pool,
      initialEmptyDatabase: true,
      log: (message) => messages.push(message),
    }),
  );
  assert.deepEqual(messages, []);
});

const databaseUrl = process.env.DATABASE_URL;
const postgresRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
if (databaseUrl === undefined && postgresRequired) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

test(
  'PostgreSQL 17 production content seed refuses occupied tables and concurrent writes without changing data',
  {
    skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false,
    timeout: 30_000,
  },
  async () => {
    if (databaseUrl === undefined)
      throw new Error('DATABASE_URL is required for PostgreSQL content seed tests.');
    const admin = new pg.Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 5_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
    });
    const schema = `content_seed_${randomUUID().replaceAll('-', '')}`;
    const tables = ['users', 'program_weeks', 'program_days', 'videos', 'achievements'] as const;
    const messages: string[] = [];
    const seedPool = (): SeedPool => {
      const pool = new pg.Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 5_000,
      });
      return {
        async connect() {
          const client = await pool.connect();
          try {
            await client.query(`SET search_path TO "${schema}", public`);
            // The seed must override a role's less suitable isolation default.
            await client.query("SET default_transaction_isolation TO 'repeatable read'");
            return client;
          } catch (error) {
            client.release(true);
            throw error;
          }
        },
        end: () => pool.end(),
      };
    };
    try {
      const version = await admin.query<{ server_version_num: string }>('SHOW server_version_num');
      assert.ok(
        Number(version.rows[0]?.server_version_num) >= 170_000 &&
          Number(version.rows[0]?.server_version_num) < 180_000,
        'Mandatory content seed gate requires PostgreSQL 17.',
      );
      await admin.query(`CREATE SCHEMA "${schema}"`);
      for (const table of tables)
        await admin.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
      await runContentSeed({
        pool: seedPool(),
        initialEmptyDatabase: true,
        log: (message) => messages.push(message),
      });
      assert.deepEqual(messages, ['KINETRA_CONTENT_SEED=PASS', JSON.stringify(expectedCounts)]);
      const original = await admin.query(
        `SELECT code, title FROM "${schema}".achievements ORDER BY code`,
      );
      await assert.rejects(
        runContentSeed({
          pool: seedPool(),
          initialEmptyDatabase: true,
          log: () => assert.fail('refused seed must not emit PASS'),
        }),
        { code: 'KINETRA_CONTENT_SEED_NOT_EMPTY' },
      );
      assert.deepEqual(
        (await admin.query(`SELECT code, title FROM "${schema}".achievements ORDER BY code`)).rows,
        original.rows,
      );
      // Nonproduction retains the established repeatable seed contract.
      await runContentSeed({ pool: seedPool(), log: () => {} });
      assert.deepEqual(
        (await admin.query(`SELECT code, title FROM "${schema}".achievements ORDER BY code`)).rows,
        original.rows,
      );
      const seedRows = new Map<string, Record<string, unknown>>();
      for (const table of tables.filter((table) => table !== 'users')) {
        seedRows.set(
          table,
          (await admin.query(`SELECT * FROM "${schema}".${table} LIMIT 1`)).rows[0],
        );
      }
      for (const occupiedTable of tables) {
        for (const table of tables) await admin.query(`TRUNCATE "${schema}".${table}`);
        if (occupiedTable === 'users') {
          await admin.query(
            `INSERT INTO "${schema}".users (email, password_hash) VALUES ($1, $2)`,
            [`${schema}@example.test`, 'synthetic-hash'],
          );
        } else {
          await admin.query(
            `INSERT INTO "${schema}".${occupiedTable} SELECT * FROM json_populate_record(NULL::"${schema}".${occupiedTable}, $1::json)`,
            [JSON.stringify(seedRows.get(occupiedTable))],
          );
        }
        await assert.rejects(
          runContentSeed({
            pool: seedPool(),
            initialEmptyDatabase: true,
            log: () => assert.fail('refused seed must not emit PASS'),
          }),
          { code: 'KINETRA_CONTENT_SEED_NOT_EMPTY' },
        );
        for (const table of tables)
          assert.equal(
            Number(
              (await admin.query(`SELECT count(*) AS count FROM "${schema}".${table}`)).rows[0]
                .count,
            ),
            table === occupiedTable ? 1 : 0,
          );
      }
      for (const table of tables) await admin.query(`TRUNCATE "${schema}".${table}`);
      const writer = await admin.connect();
      let seedOutcome:
        Promise<{ status: 'fulfilled' } | { status: 'rejected'; error: unknown }> | undefined;
      try {
        await writer.query('BEGIN');
        await writer.query(`INSERT INTO "${schema}".users (email, password_hash) VALUES ($1, $2)`, [
          `concurrent-${schema}@example.test`,
          'synthetic-hash',
        ]);
        seedOutcome = runContentSeed({
          pool: seedPool(),
          initialEmptyDatabase: true,
          log: () => assert.fail('concurrent user must block seeding'),
        }).then(
          () => ({ status: 'fulfilled' as const }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );
        // Wait for the seed's table lock request, not an arbitrary delay. Only our
        // isolated schema's relation lock is inspected; no query text is captured.
        const deadline = Date.now() + 5_000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const result = await admin.query<{ waiting: boolean }>(
            `SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE relation = $1::regclass AND NOT granted
        ) AS waiting`,
            [`"${schema}".users`],
          );
          waiting = result.rows[0]?.waiting === true;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(waiting, true, 'seed must request a write-blocking table lock');
        await writer.query('COMMIT');
        const outcome = await seedOutcome;
        assert.equal(outcome.status, 'rejected');
        if (outcome.status === 'rejected') {
          assert.equal((outcome.error as { code?: string }).code, 'KINETRA_CONTENT_SEED_NOT_EMPTY');
        }
        assert.equal(
          Number(
            (await admin.query(`SELECT count(*) AS count FROM "${schema}".users`)).rows[0].count,
          ),
          1,
        );
        assert.equal(
          Number(
            (await admin.query(`SELECT count(*) AS count FROM "${schema}".program_weeks`)).rows[0]
              .count,
          ),
          0,
        );
      } finally {
        try {
          await writer.query('ROLLBACK');
        } finally {
          writer.release(true);
          await seedOutcome;
        }
      }
      console.log('KINETRA_PRODUCTION_CONTENT_SEED_POSTGRES_TEST=PASS');
    } finally {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  },
);
