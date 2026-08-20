import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnv } from 'dotenv';
import pg from 'pg';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(backendRoot, '../..');

loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true });

const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://kinetra:kinetra_local_only@localhost:5432/kinetra';

const requiredTables = [
  'videos',
  'program_weeks',
  'program_days',
  'subscriptions',
  'video_progress',
  'workout_completions',
  'weekly_metrics',
  'achievements',
  'user_achievements',
];

const requiredConstraints = [
  'videos_slug_unique',
  'videos_type_valid',
  'videos_schedule_fields_valid',
  'videos_status_valid',
  'videos_storage_key_not_blank',
  'videos_workout_storage_key_required',
  'program_weeks_number_unique',
  'program_weeks_number_valid',
  'program_weeks_status_valid',
  'program_days_program_week_fk',
  'program_days_week_day_unique',
  'program_days_day_of_week_valid',
  'program_days_direction_valid',
  'subscriptions_user_fk',
  'subscriptions_provider_valid',
  'subscriptions_status_valid',
  'video_progress_user_fk',
  'video_progress_video_fk',
  'video_progress_completion_valid',
  'video_progress_completed_state_valid',
  'workout_completions_user_fk',
  'workout_completions_video_fk',
  'workout_completions_user_video_week_unique',
  'workout_completions_program_week_valid',
  'workout_completions_source_valid',
  'weekly_metrics_user_fk',
  'weekly_metrics_user_week_unique',
  'weekly_metrics_program_week_valid',
  'achievements_code_unique',
  'user_achievements_user_fk',
  'user_achievements_achievement_fk',
];

const requiredIndexes = [
  'videos_workout_schedule_unique_idx',
  'videos_type_status_order_idx',
  'program_weeks_status_number_idx',
  'program_days_week_direction_idx',
  'subscriptions_provider_external_unique_idx',
  'subscriptions_user_status_expires_idx',
  'video_progress_video_completion_idx',
  'video_progress_user_completed_idx',
  'workout_completions_user_date_idx',
  'workout_completions_video_idx',
  'weekly_metrics_week_idx',
  'achievements_rule_idx',
  'user_achievements_achievement_unlocked_idx',
];

const seededAchievementCodes = [
  'first_base_lesson',
  'base_unlocked',
  'first_workout',
  'week_complete',
  'streak_3',
];

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  const tableResult = await client.query(
    `
      SELECT tablename
      FROM pg_catalog.pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
    `,
    [requiredTables],
  );
  const foundTables = new Set(tableResult.rows.map((row) => row.tablename));

  for (const table of requiredTables) {
    assert(foundTables.has(table), `Missing table: ${table}.`);
  }

  const constraintResult = await client.query(
    `
      SELECT conname
      FROM pg_catalog.pg_constraint
      WHERE conname = ANY($1::text[])
    `,
    [requiredConstraints],
  );
  const foundConstraints = new Set(constraintResult.rows.map((row) => row.conname));

  for (const constraint of requiredConstraints) {
    assert(foundConstraints.has(constraint), `Missing constraint: ${constraint}.`);
  }

  const indexResult = await client.query(
    `
      SELECT indexname
      FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1::text[])
    `,
    [requiredIndexes],
  );
  const foundIndexes = new Set(indexResult.rows.map((row) => row.indexname));

  for (const index of requiredIndexes) {
    assert(foundIndexes.has(index), `Missing index: ${index}.`);
  }

  const contentResult = await client.query(
    `
      SELECT
        (SELECT COUNT(*)::integer FROM program_weeks) AS program_weeks,
        (SELECT COUNT(*)::integer FROM program_days) AS program_days,
        (
          SELECT COUNT(*)::integer
          FROM videos
          WHERE slug LIKE 'base-lesson-%'
            AND type = 'base_lesson'
            AND day_of_week IS NULL
            AND week_number IS NULL
            AND duration_seconds > 0
        ) AS base_lessons,
        (
          SELECT COUNT(*)::integer
          FROM videos
          WHERE slug LIKE 'workout-week-%'
            AND type = 'workout'
            AND day_of_week BETWEEN 1 AND 7
            AND week_number BETWEEN 1 AND 12
            AND duration_seconds > 0
        ) AS workouts,
        (
          SELECT COUNT(*)::integer
          FROM (
            SELECT week_number, day_of_week
            FROM videos
            WHERE slug LIKE 'workout-week-%'
              AND type = 'workout'
            GROUP BY week_number, day_of_week
          ) AS workout_slots
        ) AS workout_slots,
        (
          SELECT COUNT(*)::integer
          FROM achievements
          WHERE code = ANY($1::text[])
        ) AS achievements,
        (
          SELECT COUNT(*)::integer
          FROM videos
          WHERE type = 'base_lesson'
            AND (
              storage_key ~ '^videos/base-lessons/0[1-7]\\.mp4$'
              OR poster_key ~ '^posters/base-lessons/0[1-7]\\.jpg$'
            )
        ) AS legacy_base_lesson_placeholders
    `,
    [seededAchievementCodes],
  );

  const counts = contentResult.rows[0];
  assert(counts?.program_weeks === 12, 'Expected 12 program weeks.');
  assert(counts?.program_days === 84, 'Expected 84 program days.');
  assert(counts?.base_lessons === 7, 'Expected 7 valid base lessons.');
  assert(counts?.workouts === 84, 'Expected 84 valid workout videos.');
  assert(counts?.workout_slots === 84, 'Expected 84 unique workout schedule slots.');
  assert(counts?.achievements === 5, 'Expected 5 seeded achievements.');
  assert(
    counts?.legacy_base_lesson_placeholders === 0,
    'Known T03 base lesson placeholder storage keys must be null or replaced with real keys.',
  );

  const baseLessonConstraintResult = await client.query(
    `
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_catalog.pg_constraint
      WHERE conname = ANY($1::text[])
    `,
    [
      [
        'videos_storage_key_not_blank',
        'videos_workout_storage_key_required',
        'video_progress_completed_state_valid',
      ],
    ],
  );
  const constraintDefinitions = new Map(
    baseLessonConstraintResult.rows.map((row) => [row.conname, row.definition]),
  );
  assert(
    constraintDefinitions.get('videos_storage_key_not_blank')?.includes('storage_key IS NULL'),
    'Base lessons must allow a null storage key.',
  );
  assert(
    constraintDefinitions
      .get('videos_workout_storage_key_required')
      ?.includes('storage_key IS NOT NULL'),
    'Workout videos must retain a required storage key.',
  );
  assert(
    /completion_percent\s*>=\s*\(?90\)?/u.test(
      constraintDefinitions.get('video_progress_completed_state_valid') ?? '',
    ),
    'Completed progress must use the 90 percent threshold.',
  );

  const scheduleResult = await client.query(`
    SELECT
      day_of_week,
      direction,
      duration_minutes,
      COUNT(*)::integer AS occurrences
    FROM program_days
    GROUP BY day_of_week, direction, duration_minutes
    ORDER BY day_of_week
  `);

  const expectedSchedule = [
    [1, 'breathing', 25],
    [2, 'strength', 35],
    [3, 'body_therapy', 30],
    [4, 'functional', 35],
    [5, 'stretching', 30],
    [6, 'neuro', 15],
    [7, 'recovery', 20],
  ];

  assert(scheduleResult.rowCount === expectedSchedule.length, 'Unexpected schedule variants.');

  for (const [index, expected] of expectedSchedule.entries()) {
    const row = scheduleResult.rows[index];
    assert(row?.day_of_week === expected[0], `Unexpected day at schedule row ${index}.`);
    assert(row?.direction === expected[1], `Unexpected direction at schedule row ${index}.`);
    assert(row?.duration_minutes === expected[2], `Unexpected duration at schedule row ${index}.`);
    assert(row?.occurrences === 12, `Expected schedule row ${index} in all 12 weeks.`);
  }

  await client.query('BEGIN');

  try {
    const userResult = await client.query(
      `
        INSERT INTO users (email, password_hash)
        VALUES ($1, $2)
        RETURNING id
      `,
      ['t03-verifier@kinetra.invalid', '$2b$12$verification.hash.placeholder'],
    );
    const userId = userResult.rows[0]?.id;
    assert(typeof userId === 'string', 'Could not create verification user.');

    await client.query('SAVEPOINT invalid_provider');

    try {
      await client.query(
        `
          INSERT INTO subscriptions (user_id, provider, status)
          VALUES ($1, 'unsupported_provider', 'pending')
        `,
        [userId],
      );
      throw new Error('Invalid subscription provider was accepted.');
    } catch (error) {
      assert(error?.code === '23514', 'Provider CHECK constraint did not reject invalid data.');
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT invalid_provider');
      await client.query('RELEASE SAVEPOINT invalid_provider');
    }

    await client.query('SAVEPOINT invalid_video_type');

    try {
      await client.query(
        `
          INSERT INTO videos (
            slug,
            title,
            type,
            duration_seconds,
            storage_key,
            status,
            order_index
          )
          VALUES ('invalid-video-type', 'Invalid', 'other', 60, 'invalid.mp4', 'draft', 0)
        `,
      );
      throw new Error('Invalid video type was accepted.');
    } catch (error) {
      assert(error?.code === '23514', 'Video type CHECK constraint did not reject invalid data.');
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT invalid_video_type');
      await client.query('RELEASE SAVEPOINT invalid_video_type');
    }
  } finally {
    await client.query('ROLLBACK');
  }

  console.log('KINETRA_T03_DATABASE_VERIFICATION=PASS');
  console.log(
    JSON.stringify({
      tables: requiredTables.length,
      constraints: requiredConstraints.length,
      indexes: requiredIndexes.length,
      programWeeks: 12,
      programDays: 84,
      baseLessons: 7,
      workouts: 84,
      achievements: 5,
    }),
  );
} finally {
  client.release();
  await pool.end();
}
