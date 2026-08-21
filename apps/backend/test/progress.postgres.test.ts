import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresProgramRepository } from '../src/program/postgres-program.repository.js';
import { PostgresProgressRepository } from '../src/progress/postgres-progress.repository.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

const rejectsConstraint = async (promise: Promise<unknown>, constraint: string): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    if (typeof error !== 'object' || error === null || !('constraint' in error)) {
      return false;
    }

    return (error as { readonly constraint?: unknown }).constraint === constraint;
  });
};

test(
  'PostgreSQL progress repository upserts metrics, versions goals and aggregates achievements',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const userId = randomUUID();
    const repository = new PostgresProgressRepository(pool);
    const programRepository = new PostgresProgramRepository(pool);

    try {
      await pool.query(
        `
          INSERT INTO users (id, email, password_hash, onboarding_status)
          VALUES ($1, $2, $3, 'active')
        `,
        [
          userId,
          `progress-${userId}@example.com`,
          '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
        ],
      );
      await pool.query(
        `
          INSERT INTO survey_answers (
            user_id,
            version,
            gender,
            age_range,
            goal,
            injuries,
            experience,
            is_current
          )
          VALUES ($1, 1, 'female', '26-35', 'flexibility', $2::text[], 'novice', true)
        `,
        [userId, ['knees']],
      );

      assert.equal(
        await repository.upsertWeeklyMetrics(userId, {
          programWeek: 2,
          energy: 7,
          sleep: 6,
          mood: 7,
          bodySatisfaction: 6,
          note: null,
        }),
        true,
      );
      assert.equal(
        await repository.upsertWeeklyMetrics(userId, {
          programWeek: 1,
          energy: 6,
          sleep: 5,
          mood: 7,
          bodySatisfaction: 5,
          note: 'Было тяжело, но интересно',
        }),
        true,
      );
      const beforeUpdate = await repository.getMetrics(userId);
      assert.deepEqual(
        beforeUpdate?.map((metric) => metric.programWeek),
        [1, 2],
      );
      const originalCreatedAt = beforeUpdate?.[0]?.createdAt.toISOString();

      await repository.upsertWeeklyMetrics(userId, {
        programWeek: 1,
        energy: 8,
        sleep: 7,
        mood: 8,
        bodySatisfaction: 7,
        note: 'Чувствую прилив сил',
      });
      const afterUpdate = await repository.getMetrics(userId);
      assert.equal(afterUpdate?.length, 2);
      assert.equal(afterUpdate?.[0]?.energy, 8);
      assert.equal(afterUpdate?.[0]?.note, 'Чувствую прилив сил');
      assert.equal(afterUpdate?.[0]?.createdAt.toISOString(), originalCreatedAt);

      await rejectsConstraint(
        pool.query(
          `
            INSERT INTO weekly_metrics (
              user_id, program_week, energy, sleep, mood, body_satisfaction, note
            )
            VALUES ($1, 3, 5, 5, 5, 5, $2)
          `,
          [userId, 'x'.repeat(501)],
        ),
        'weekly_metrics_note_length_valid',
      );

      const updatedGoal = await repository.updateGoalVersion(userId, 'strength');
      assert.equal(updatedGoal?.goal, 'strength');
      assert.equal(updatedGoal?.gender, 'female');
      assert.deepEqual(updatedGoal?.injuries, ['knees']);
      assert.equal(updatedGoal?.experience, 'novice');
      const surveyVersions = await pool.query<{
        readonly version: number;
        readonly is_current: boolean;
      }>(
        `
          SELECT version, is_current
          FROM survey_answers
          WHERE user_id = $1
          ORDER BY version
        `,
        [userId],
      );
      assert.deepEqual(surveyVersions.rows, [
        { version: 1, is_current: false },
        { version: 2, is_current: true },
      ]);

      const workouts = await pool.query<{
        readonly id: string;
        readonly day_of_week: number;
        readonly duration_seconds: number;
      }>(
        `
          SELECT id, day_of_week, duration_seconds
          FROM videos
          WHERE type = 'workout'
            AND status = 'published'
            AND week_number = 1
          ORDER BY day_of_week
        `,
      );
      assert.equal(workouts.rows.length, 7);
      const dayOffsets = [10, 9, 8, 6, 4, 2, 1];

      for (const [index, workout] of workouts.rows.entries()) {
        await pool.query(
          `
            INSERT INTO workout_completions (
              user_id,
              video_id,
              program_week,
              workout_date,
              completed_at,
              source
            )
            VALUES (
              $1,
              $2,
              1,
              CURRENT_DATE - $3::integer,
              NOW() - ($3::text || ' days')::interval,
              'manual_admin'
            )
          `,
          [userId, workout.id, dayOffsets[index]],
        );
      }

      const baseLessons = await pool.query<{ readonly id: string }>(
        `
          SELECT id
          FROM videos
          WHERE type = 'base_lesson'
            AND status = 'published'
          ORDER BY order_index
          LIMIT 4
        `,
      );
      assert.equal(baseLessons.rows.length, 4);

      for (const lesson of baseLessons.rows) {
        await pool.query(
          `
            INSERT INTO video_progress (
              user_id,
              video_id,
              position_seconds,
              completion_percent,
              completed_at
            )
            VALUES ($1, $2, 600, 100, NOW())
          `,
          [userId, lesson.id],
        );
      }

      await pool.query(
        `
          INSERT INTO workout_completions (
            user_id,
            video_id,
            program_week,
            workout_date,
            completed_at,
            source
          )
          VALUES ($1, $2, 1, CURRENT_DATE, NOW(), 'manual_admin')
        `,
        [userId, baseLessons.rows[0]?.id],
      );

      const dashboard = await repository.getDashboard(userId);
      assert.notEqual(dashboard, null);
      assert.deepEqual(dashboard?.stats, {
        totalWorkouts: 7,
        totalWeeksCompleted: 1,
        currentStreak: 2,
        bestStreak: 3,
        totalMinutesTrained: 190,
      });
      assert.equal(dashboard?.achievements.length, 5);
      assert.equal(
        dashboard?.achievements.every((achievement) => achievement.unlockedAt !== null),
        true,
      );
      const firstWorkoutUnlock = dashboard?.achievements.find(
        (achievement) => achievement.code === 'first_workout',
      )?.unlockedAt;
      assert.notEqual(firstWorkoutUnlock, null);
      assert.equal(
        (firstWorkoutUnlock?.getTime() ?? Date.now()) < Date.now() - 7 * 24 * 60 * 60 * 1_000,
        true,
        'Historical achievements must retain the source event time instead of the first GET time.',
      );
      const unlockTimes = dashboard?.achievements.map((achievement) =>
        achievement.unlockedAt?.toISOString(),
      );

      const repeated = await repository.getDashboard(userId);
      assert.deepEqual(
        repeated?.achievements.map((achievement) => achievement.unlockedAt?.toISOString()),
        unlockTimes,
      );
      const persistedAchievements = await pool.query<{ readonly total: number }>(
        `
          SELECT COUNT(*)::integer AS total
          FROM user_achievements
          WHERE user_id = $1
        `,
        [userId],
      );
      assert.equal(persistedAchievements.rows[0]?.total, 5);

      const program = await programRepository.getProgress(userId);
      assert.equal(program.currentWeekNumber, 2);
      assert.equal(program.weeksCompleted, 1);
      assert.equal(program.totalWorkoutsDone, 7);
      console.log('KINETRA_T09_POSTGRES_INTEGRATION=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      await pool.end();
    }
  },
);
