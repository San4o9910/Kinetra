import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresProgramRepository } from '../src/program/postgres-program.repository.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

test(
  'PostgreSQL program repository validates workouts, stays idempotent, and advances after day seven',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 3 });
    const userId = randomUUID();
    const repository = new PostgresProgramRepository(pool);

    try {
      await pool.query(
        `
          INSERT INTO users (id, email, password_hash, onboarding_status)
          VALUES ($1, $2, $3, 'active')
        `,
        [
          userId,
          `program-${userId}@example.com`,
          '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
        ],
      );

      const initial = await repository.getProgress(userId);
      assert.deepEqual(initial, {
        currentWeekNumber: 1,
        totalWeeks: 12,
        weeksCompleted: 0,
        totalWorkoutsDone: 0,
      });

      const week = await repository.getWeek(userId, 1);
      assert.notEqual(week, null);
      assert.equal(week?.days.length, 7);
      assert.deepEqual(
        week?.days.map((day) => day.dayOfWeek),
        [1, 2, 3, 4, 5, 6, 7],
      );
      assert.equal(
        week?.days.every((day) => day.mediaAvailable === false),
        true,
      );

      const firstVideoId = week?.days[0]?.videoId;
      assert.equal(typeof firstVideoId, 'string');

      const mismatch = await repository.completeWorkout(userId, firstVideoId as string, 2);
      assert.deepEqual(mismatch, { kind: 'workout_not_found' });

      const inserted = await repository.completeWorkout(userId, firstVideoId as string, 1);
      assert.deepEqual(inserted, { kind: 'completed', inserted: true });
      const repeated = await repository.completeWorkout(userId, firstVideoId as string, 1);
      assert.deepEqual(repeated, { kind: 'completed', inserted: false });

      let afterCompletion = await repository.getProgress(userId);
      assert.equal(afterCompletion.currentWeekNumber, 1);
      assert.equal(afterCompletion.totalWorkoutsDone, 1);
      assert.equal(
        (await repository.getWeek(userId, 1))?.days[0]?.completedAt instanceof Date,
        true,
      );

      for (const day of week?.days.slice(1) ?? []) {
        const result = await repository.completeWorkout(userId, day.videoId, 1);
        assert.deepEqual(result, { kind: 'completed', inserted: true });
      }

      afterCompletion = await repository.getProgress(userId);
      assert.equal(afterCompletion.currentWeekNumber, 2);
      assert.equal(afterCompletion.weeksCompleted, 1);
      assert.equal(afterCompletion.totalWorkoutsDone, 7);

      const persisted = await pool.query<{
        readonly total: number;
        readonly player_total: number;
      }>(
        `
          SELECT
            COUNT(*)::integer AS total,
            COUNT(*) FILTER (WHERE source = 'player')::integer AS player_total
          FROM workout_completions
          WHERE user_id = $1
            AND program_week = 1
            AND workout_date = CURRENT_DATE
        `,
        [userId],
      );
      assert.deepEqual(persisted.rows[0], { total: 7, player_total: 7 });
      console.log('KINETRA_T07_POSTGRES_INTEGRATION=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      await pool.end();
    }
  },
);
