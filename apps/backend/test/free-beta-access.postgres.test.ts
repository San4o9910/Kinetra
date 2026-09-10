import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresFreeBetaAccessChecker } from '../src/program/free-beta-access.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

test(
  'PostgreSQL 17 free beta admits at most the first 15 current trainees and excludes trainers',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 1 });

    try {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        const version = await client.query<{ readonly server_version_num: string }>(
          "SELECT current_setting('server_version_num') AS server_version_num",
        );
        const serverVersion = Number(version.rows[0]?.server_version_num ?? '0');
        assert.ok(serverVersion >= 170000 && serverVersion < 180000, 'PostgreSQL 17 is required.');

        // These connection-local tables shadow public fixtures used by parallel test files.
        await client.query(`
          CREATE TEMPORARY TABLE users (
            id uuid PRIMARY KEY,
            requested_role text NOT NULL,
            created_at timestamptz NOT NULL
          ) ON COMMIT DROP
        `);
        await client.query(`
          CREATE TEMPORARY TABLE trainer_profiles (
            user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            is_active boolean NOT NULL
          ) ON COMMIT DROP
        `);

        const traineeIds = Array.from({ length: 16 }, () => randomUUID()).sort();
        const requestedTrainerId = randomUUID();
        const activeTrainerId = randomUUID();
        const unknownUserId = randomUUID();
        const eligibleTimes = traineeIds.map((_, index) =>
          index < 14
            ? new Date(Date.UTC(2026, 0, 2, 0, 0, index))
            : new Date('2026-01-03T00:00:00.000Z'),
        );

        // Insertion order deliberately differs from created_at/id order. The final pair
        // shares a timestamp, so the fifteenth slot must use the UUID tie-breaker.
        for (let index = traineeIds.length - 1; index >= 0; index -= 1) {
          await client.query(
            `INSERT INTO users (id, requested_role, created_at) VALUES ($1, 'trainee', $2)`,
            [traineeIds[index], eligibleTimes[index]],
          );
        }
        await client.query(
          `INSERT INTO users (id, requested_role, created_at)
           VALUES ($1, 'trainer', $3), ($2, 'trainee', $3)`,
          [requestedTrainerId, activeTrainerId, new Date('2026-01-01T00:00:00.000Z')],
        );
        await client.query(
          `INSERT INTO trainer_profiles (user_id, is_active)
           VALUES ($1, true), ($2, false)`,
          [activeTrainerId, traineeIds[0]],
        );

        const checker = new PostgresFreeBetaAccessChecker(client, true);
        const access = [];

        for (const [index, userId] of traineeIds.entries()) {
          const allowed = await checker.hasFreeBetaAccess(userId);
          assert.equal(allowed, index < 15, `Unexpected access for trainee ${index + 1}.`);
          access.push(allowed);
        }

        assert.equal(access.filter(Boolean).length, 15);
        assert.equal(await checker.hasFreeBetaAccess(requestedTrainerId), false);
        assert.equal(await checker.hasFreeBetaAccess(activeTrainerId), false);
        assert.equal(await checker.hasFreeBetaAccess(unknownUserId), false);

        const disabledChecker = new PostgresFreeBetaAccessChecker(client, false);
        for (const userId of traineeIds) {
          assert.equal(await disabledChecker.hasFreeBetaAccess(userId), false);
        }

        const deletedUserId = traineeIds[0];
        const replacementUserId = traineeIds[15];
        assert.ok(deletedUserId);
        assert.ok(replacementUserId);
        await client.query('DELETE FROM users WHERE id = $1', [deletedUserId]);
        assert.equal(await checker.hasFreeBetaAccess(deletedUserId), false);
        assert.equal(await checker.hasFreeBetaAccess(replacementUserId), true);

        let remainingAccessCount = 0;
        for (const userId of traineeIds) {
          if (await checker.hasFreeBetaAccess(userId)) remainingAccessCount += 1;
        }
        assert.equal(remainingAccessCount, 15);
        console.log('KINETRA_FREE_BETA_POSTGRES17=PASS');
      } finally {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
    } finally {
      await pool.end();
    }
  },
);
