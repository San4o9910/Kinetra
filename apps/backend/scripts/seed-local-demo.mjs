import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import bcrypt from 'bcrypt';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

import {
  assertLocalDemoDatabase,
  defaultLocalDatabaseUrl,
  parseDemoClientEmail,
} from '../../../scripts/local-demo-guard.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(scriptDirectory, '..');
const repositoryRoot = resolve(backendRoot, '../..');

loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true });

const databaseUrl = process.env.DATABASE_URL ?? defaultLocalDatabaseUrl;
const demoTrainerEmail = 'trainer.demo@kinetra.local';
const demoTrainerUsername = 'kinetra_local_demo_trainer';

const fail = (message) => {
  throw new Error(`LOCAL_DEMO_REFUSED: ${message}`);
};

const clientEmail = parseDemoClientEmail(process.argv.slice(2), demoTrainerEmail);
assertLocalDemoDatabase({
  databaseUrl,
  nodeEnvironment: process.env.NODE_ENV,
  confirmation: process.env.KINETRA_LOCAL_DEMO_CONFIRMATION,
});

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    'kinetra-local-demo-full-access-v1',
  ]);

  const databaseIdentity = await client.query(
    'SELECT current_database() AS database_name, current_user AS database_user',
  );
  const identity = databaseIdentity.rows[0];

  if (identity?.database_name !== 'kinetra' || identity.database_user !== 'kinetra') {
    fail('the connected PostgreSQL database is not the dedicated local kinetra database.');
  }

  const content = await client.query(
    `SELECT
       (SELECT COUNT(*)::integer FROM program_weeks) AS weeks,
       (SELECT COUNT(*)::integer FROM videos WHERE type = 'workout') AS workouts,
       (SELECT COUNT(*)::integer FROM videos WHERE type = 'base_lesson') AS base_lessons`,
  );
  const contentCounts = content.rows[0];

  if (
    contentCounts?.weeks !== 12 ||
    contentCounts.workouts !== 84 ||
    contentCounts.base_lessons !== 7
  ) {
    fail('content is incomplete; run migrations and the regular content seed first.');
  }

  const userResult = await client.query(
    `SELECT
       user_record.id,
       user_record.requested_role,
       EXISTS (
         SELECT 1
         FROM trainer_profiles AS profile
         WHERE profile.user_id = user_record.id
           AND profile.is_active = true
       ) AS is_trainer
     FROM users AS user_record
     WHERE user_record.email = $1
     FOR UPDATE`,
    [clientEmail],
  );
  const user = userResult.rows[0];

  if (user === undefined) {
    fail(`account ${clientEmail} was not found; register it in the app first.`);
  }

  if (user.requested_role === 'trainer' || user.is_trainer === true) {
    fail('select a trainee account, not a trainer account.');
  }

  const clientUserId = user.id;

  await client.query(
    `UPDATE users
     SET onboarding_status = 'active',
         email_verified = true,
         email_verified_at = COALESCE(email_verified_at, NOW()),
         updated_at = NOW()
     WHERE id = $1`,
    [clientUserId],
  );

  await client.query(
    `INSERT INTO survey_answers (
       user_id,
       version,
       gender,
       age_range,
       goal,
       injuries,
       injuries_detail,
       experience,
       is_current
     )
     SELECT
       $1,
       COALESCE(MAX(existing.version), 0) + 1,
       'male',
       '26-35',
       'general_health',
       ARRAY['none']::text[],
       NULL,
       'novice',
       true
     FROM survey_answers AS existing
     WHERE existing.user_id = $1
     HAVING NOT EXISTS (
       SELECT 1
       FROM survey_answers AS current_answer
       WHERE current_answer.user_id = $1
         AND current_answer.is_current = true
     )`,
    [clientUserId],
  );

  await client.query(
    `INSERT INTO video_progress AS progress (
       user_id,
       video_id,
       position_seconds,
       completion_percent,
       completed_at
     )
     SELECT $1, video.id, video.duration_seconds, 100, NOW() - INTERVAL '14 days'
     FROM videos AS video
     WHERE video.type = 'base_lesson'
       AND video.status = 'published'
     ORDER BY video.order_index, video.id
     LIMIT 4
     ON CONFLICT (user_id, video_id) DO UPDATE SET
       position_seconds = EXCLUDED.position_seconds,
       completion_percent = 100,
       completed_at = COALESCE(progress.completed_at, EXCLUDED.completed_at)`,
    [clientUserId],
  );

  await client.query(
    `INSERT INTO subscriptions (
       user_id,
       provider,
       provider_subscription_id,
       status,
       starts_at,
       expires_at,
       amount_minor,
       currency,
       auto_renew,
       raw_payload
     )
     VALUES (
       $1,
       'yukassa',
       $2,
       'active',
       NOW() - INTERVAL '1 day',
       NOW() + INTERVAL '30 days',
       79900,
       'RUB',
       false,
       jsonb_build_object('mode', 'local_demo', 'simulated', true)
     )
     ON CONFLICT (provider, provider_subscription_id)
       WHERE provider_subscription_id IS NOT NULL
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       status = 'active',
       starts_at = EXCLUDED.starts_at,
       expires_at = EXCLUDED.expires_at,
       amount_minor = EXCLUDED.amount_minor,
       currency = EXCLUDED.currency,
       auto_renew = false,
       payment_method_id = NULL,
       raw_payload = EXCLUDED.raw_payload,
       updated_at = NOW()`,
    [clientUserId, `local-demo-${clientUserId}`],
  );

  await client.query(
    `WITH selected_workouts AS (
       SELECT id, week_number, day_of_week
       FROM videos
       WHERE type = 'workout'
         AND status = 'published'
         AND (
           week_number = 1
           OR (week_number = 2 AND day_of_week <= 3)
         )
     )
     INSERT INTO workout_completions (
       user_id,
       video_id,
       program_week,
       workout_date,
       completed_at,
       source
     )
     SELECT
       $1,
       workout.id,
       workout.week_number,
       CASE
         WHEN workout.week_number = 1
           THEN CURRENT_DATE - (10 - workout.day_of_week)
         ELSE CURRENT_DATE - (3 - workout.day_of_week)
       END,
       CASE
         WHEN workout.week_number = 1
           THEN CURRENT_DATE - (10 - workout.day_of_week) + TIME '18:00'
         ELSE CURRENT_DATE - (3 - workout.day_of_week) + TIME '18:00'
       END,
       'manual_admin'
     FROM selected_workouts AS workout
     ON CONFLICT ON CONSTRAINT workout_completions_user_video_week_unique
     DO NOTHING`,
    [clientUserId],
  );

  await client.query(
    `INSERT INTO weekly_metrics (
       user_id,
       program_week,
       energy,
       sleep,
       mood,
       body_satisfaction,
       note
     )
     VALUES
       ($1, 1, 6, 7, 7, 6, 'Первая демо-неделя завершена.'),
       ($1, 2, 8, 7, 8, 7, 'Прогресс для знакомства с приложением.')
     ON CONFLICT ON CONSTRAINT weekly_metrics_user_week_unique
     DO NOTHING`,
    [clientUserId],
  );

  const activeDefaultTrainer = await client.query(
    `SELECT profile.user_id, profile.display_name
     FROM trainer_profiles AS profile
     WHERE profile.is_active = true
       AND profile.is_default = true
     LIMIT 1
     FOR UPDATE`,
  );

  let trainerUserId = activeDefaultTrainer.rows[0]?.user_id;
  let trainerDisplayName = activeDefaultTrainer.rows[0]?.display_name;
  let createdDemoTrainer = false;

  if (trainerUserId === undefined) {
    const reservedTrainer = await client.query(
      `SELECT id, email, username, requested_role
       FROM users
       WHERE email = $1 OR username = $2
       FOR UPDATE`,
      [demoTrainerEmail, demoTrainerUsername],
    );
    const reservedUser = reservedTrainer.rows[0];

    if (
      reservedTrainer.rowCount > 1 ||
      (reservedUser !== undefined &&
        (reservedUser.email !== demoTrainerEmail ||
          reservedUser.username !== demoTrainerUsername ||
          reservedUser.requested_role !== 'trainer'))
    ) {
      fail('the reserved local demo trainer identity is already in use.');
    }

    if (reservedUser === undefined) {
      const randomPassword = randomBytes(24).toString('base64url');
      const trainerPasswordHash = await bcrypt.hash(randomPassword, 10);
      const insertedTrainer = await client.query(
        `INSERT INTO users (
           email,
           password_hash,
           email_verified,
           email_verified_at,
           username,
           first_name,
           onboarding_status,
           level,
           requested_role
         )
         VALUES ($1, $2, true, NOW(), $3, 'Анна', 'active', 'advanced', 'trainer')
         RETURNING id`,
        [demoTrainerEmail, trainerPasswordHash, demoTrainerUsername],
      );
      trainerUserId = insertedTrainer.rows[0]?.id;
      createdDemoTrainer = true;
    } else {
      trainerUserId = reservedUser.id;
    }

    if (trainerUserId === undefined) {
      throw new Error('PostgreSQL did not return the local demo trainer ID.');
    }

    const existingProfile = await client.query(
      `SELECT user_id
       FROM trainer_profiles
       WHERE user_id = $1
       FOR UPDATE`,
      [trainerUserId],
    );

    if (!createdDemoTrainer && existingProfile.rowCount === 0) {
      fail('the reserved trainer user is not owned by the local demo fixture.');
    }

    if (!createdDemoTrainer) {
      const clientChatHistory = await client.query(
        `SELECT 1
         FROM chat_conversations
         WHERE client_user_id = $1
         LIMIT 1`,
        [trainerUserId],
      );

      if (clientChatHistory.rowCount !== 0) {
        fail('the reserved trainer user has client chat history and cannot be reactivated.');
      }
    }

    if (createdDemoTrainer) {
      await client.query(
        `INSERT INTO trainer_profiles (
           user_id,
           display_name,
           is_active,
           is_default,
           can_manage_videos
         )
         VALUES ($1, 'Анна · демо-тренер', true, true, false)`,
        [trainerUserId],
      );
    } else {
      await client.query(
        `UPDATE trainer_profiles
         SET display_name = 'Анна · демо-тренер',
             is_active = true,
             is_default = true,
             can_manage_videos = false,
             updated_at = NOW()
         WHERE user_id = $1`,
        [trainerUserId],
      );
    }

    trainerDisplayName = 'Анна · демо-тренер';
  }

  const verification = await client.query(
    `SELECT
       user_record.onboarding_status,
       EXISTS (
         SELECT 1
         FROM subscriptions AS subscription
         WHERE subscription.user_id = user_record.id
           AND subscription.status = 'active'
           AND subscription.starts_at <= NOW()
           AND subscription.expires_at > NOW()
       ) AS subscription_active,
       (
         SELECT COUNT(*)::integer
         FROM workout_completions AS completion
         WHERE completion.user_id = user_record.id
       ) AS workouts_completed,
       (
         SELECT COUNT(*)::integer
         FROM video_progress AS progress
         INNER JOIN videos AS video ON video.id = progress.video_id
         WHERE progress.user_id = user_record.id
           AND video.type = 'base_lesson'
           AND progress.completion_percent >= 90
       ) AS base_lessons_completed,
       EXISTS (
         SELECT 1
         FROM trainer_profiles AS profile
         WHERE profile.user_id = $2
           AND profile.is_active = true
           AND profile.is_default = true
       ) AS default_trainer_ready
     FROM users AS user_record
     WHERE user_record.id = $1`,
    [clientUserId, trainerUserId],
  );
  const state = verification.rows[0];

  if (
    state?.onboarding_status !== 'active' ||
    state.subscription_active !== true ||
    state.workouts_completed < 10 ||
    state.base_lessons_completed < 4 ||
    state.default_trainer_ready !== true
  ) {
    throw new Error('Local demo verification failed.');
  }

  await client.query('COMMIT');

  console.log('KINETRA_LOCAL_DEMO=PASS');
  console.log(`CLIENT_EMAIL=${clientEmail}`);
  console.log('SIMULATED_SUBSCRIPTION=ACTIVE');
  console.log(`SIMULATED_WORKOUTS_COMPLETED=${String(state.workouts_completed)}`);
  console.log(`CHAT_TRAINER=${String(trainerDisplayName ?? trainerUserId)}`);
  console.log(`DEMO_TRAINER_CREATED=${String(createdDemoTrainer)}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
