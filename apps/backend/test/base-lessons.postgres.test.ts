import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresBaseLessonsRepository } from '../src/base-lessons/postgres-base-lessons.repository.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

test(
  'PostgreSQL base lessons repository persists monotonic progress and activates atomically',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 3 });
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const repository = new PostgresBaseLessonsRepository(pool);

    try {
      await pool.query(
        `
          INSERT INTO users (id, email, password_hash, onboarding_status)
          VALUES
            ($1, $2, $3, 'base_lessons'),
            ($4, $5, $3, 'survey_pending')
        `,
        [
          userId,
          `base-lessons-${userId}@example.com`,
          '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
          otherUserId,
          `base-lessons-${otherUserId}@example.com`,
        ],
      );

      const lessons = await repository.listForUser(userId);
      assert.equal(lessons.length, 7);
      assert.deepEqual(
        lessons.map((lesson) => lesson.orderIndex),
        [1, 2, 3, 4, 5, 6, 7],
      );
      const firstLessonId = lessons[0]?.id;
      assert.equal(typeof firstLessonId, 'string');

      const started = await repository.saveProgress(userId, firstLessonId as string, {
        positionSeconds: 300,
        completionPercent: 89.99,
      });
      assert.equal(started?.completionPercent, 89.99);
      assert.equal(started?.completedAt, null);

      const completed = await repository.saveProgress(userId, firstLessonId as string, {
        positionSeconds: 540,
        completionPercent: 90,
      });
      assert.equal(completed?.completionPercent, 90);
      assert.notEqual(completed?.completedAt, null);
      const completedAt = completed?.completedAt?.toISOString();

      const stale = await repository.saveProgress(userId, firstLessonId as string, {
        positionSeconds: 120,
        completionPercent: 20,
      });
      assert.equal(stale?.completionPercent, 90);
      assert.equal(stale?.completedAt?.toISOString(), completedAt);

      const otherUserLessons = await repository.listForUser(otherUserId);
      assert.equal(otherUserLessons[0]?.completionPercent, 0);

      const workoutResult = await pool.query<{ readonly id: string }>(
        `
          SELECT id
          FROM videos
          WHERE type = 'workout'
          ORDER BY order_index
          LIMIT 1
        `,
      );
      const workoutId = workoutResult.rows[0]?.id;
      assert.equal(typeof workoutId, 'string');
      await assert.rejects(
        pool.query('UPDATE videos SET storage_key = NULL WHERE id = $1', [workoutId]),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'constraint' in error &&
          error.constraint === 'videos_workout_storage_key_required',
      );
      assert.equal(
        await repository.saveProgress(userId, workoutId as string, {
          positionSeconds: 60,
          completionPercent: 100,
        }),
        null,
      );

      const insufficient = await repository.completeProgram(userId, 4);
      assert.deepEqual(insufficient, { kind: 'insufficient_lessons', totalCompleted: 1 });

      for (const lesson of lessons.slice(1, 4)) {
        const progress = await repository.saveProgress(userId, lesson.id, {
          positionSeconds: 540,
          completionPercent: 90,
        });
        assert.notEqual(progress?.completedAt, null);
      }

      const invalidState = await repository.completeProgram(otherUserId, 4);
      assert.deepEqual(invalidState, {
        kind: 'invalid_onboarding_state',
        status: 'survey_pending',
      });

      const activated = await repository.completeProgram(userId, 4);
      assert.deepEqual(activated, { kind: 'activated' });

      await pool.query('DELETE FROM video_progress WHERE user_id = $1', [userId]);
      const repeated = await repository.completeProgram(userId, 4);
      assert.deepEqual(repeated, { kind: 'already_active' });

      const statusResult = await pool.query<{ readonly onboarding_status: string }>(
        'SELECT onboarding_status FROM users WHERE id = $1',
        [userId],
      );
      assert.equal(statusResult.rows[0]?.onboarding_status, 'active');

      await assert.rejects(
        pool.query(
          `
            INSERT INTO video_progress (
              user_id,
              video_id,
              position_seconds,
              completion_percent,
              completed_at
            )
            VALUES ($1, $2, 1, 89, NOW())
          `,
          [otherUserId, firstLessonId],
        ),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'constraint' in error &&
          error.constraint === 'video_progress_completed_state_valid',
      );

      console.log('KINETRA_T06_POSTGRES_INTEGRATION=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]);
      await pool.end();
    }
  },
);
