import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresProfileRepository } from '../src/profile/postgres-profile.repository.js';

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
  'PostgreSQL profile repository versions surveys and restores subscription state',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const userId = randomUUID();
    const email = `profile-${userId}@example.com`;
    const repository = new PostgresProfileRepository(pool);

    try {
      await pool.query(
        `
          INSERT INTO users (
            id,
            email,
            password_hash,
            email_verified,
            onboarding_status
          )
          VALUES ($1, $2, $3, true, 'survey_pending')
        `,
        [userId, email, '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012'],
      );

      await pool.query(
        `
          INSERT INTO subscriptions (
            user_id,
            provider,
            provider_subscription_id,
            status,
            starts_at,
            expires_at,
            amount_minor,
            currency
          )
          VALUES (
            $1,
            'yukassa',
            $2,
            'active',
            NOW() - INTERVAL '1 day',
            NOW() + INTERVAL '30 days',
            99000,
            'RUB'
          )
        `,
        [userId, `test-${userId}`],
      );

      await rejectsConstraint(
        pool.query(
          `
            INSERT INTO survey_answers (
              user_id, version, gender, age_range, goal, injuries, experience
            )
            VALUES ($1, 90, 'female', '26-35', 'strength', $2::text[], 'novice')
          `,
          [userId, ['knees', 'knees']],
        ),
        'survey_answers_injuries_unique',
      );

      await rejectsConstraint(
        pool.query(
          `
            INSERT INTO survey_answers (
              user_id,
              version,
              gender,
              age_range,
              goal,
              injuries,
              injuries_detail,
              experience
            )
            VALUES ($1, 91, 'female', '26-35', 'strength', $2::text[], $3, 'novice')
          `,
          [userId, ['other'], 'x'.repeat(501)],
        ),
        'survey_answers_other_detail_valid',
      );

      const first = await repository.saveSurveyVersion(userId, {
        gender: 'female',
        ageRange: '26-35',
        goal: 'flexibility',
        injuries: ['none'],
        injuriesDetail: null,
        experience: 'beginner',
      });
      assert.notEqual(first, null);
      assert.equal(first?.onboardingStatus, 'onboarding_pending');
      assert.equal(first?.survey?.version, 1);

      const second = await repository.saveSurveyVersion(userId, {
        gender: 'female',
        ageRange: '26-35',
        goal: 'strength',
        injuries: ['knees', 'other'],
        injuriesDetail: 'Нужна щадящая нагрузка',
        experience: 'novice',
      });
      assert.notEqual(second, null);
      assert.equal(second?.survey?.version, 2);
      assert.equal(second?.survey?.goal, 'strength');
      assert.equal(second?.subscription?.status, 'active');
      assert.equal(second?.subscription?.isActive, true);

      const versions = await pool.query<{
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
      assert.deepEqual(versions.rows, [
        { version: 1, is_current: false },
        { version: 2, is_current: true },
      ]);

      const restored = await repository.findByUserId(userId);
      assert.equal(restored?.survey?.version, 2);
      assert.equal(restored?.onboardingStatus, 'onboarding_pending');
      assert.equal(restored?.accountRole, 'client');
      assert.equal(restored?.requestedRole, 'trainee');
      assert.equal(restored?.trainerVerificationState, 'not_started');

      const completed = await repository.completeOnboarding(userId);
      assert.equal(completed?.onboardingStatus, 'base_lessons');

      const completedAgain = await repository.completeOnboarding(userId);
      assert.equal(completedAgain?.onboardingStatus, 'base_lessons');

      const statusResult = await pool.query<{ readonly onboarding_status: string }>(
        'SELECT onboarding_status FROM users WHERE id = $1',
        [userId],
      );
      assert.equal(statusResult.rows[0]?.onboarding_status, 'base_lessons');
      console.log('KINETRA_T04_POSTGRES_INTEGRATION=PASS');
      console.log('KINETRA_T05_POSTGRES_INTEGRATION=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      await pool.end();
    }
  },
);

test(
  'PostgreSQL profile distinguishes requested trainer state from granted trainer authority',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL profile integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const repository = new PostgresProfileRepository(pool);
    const userId = randomUUID();
    const email = `profile-role-${userId}@example.com`;
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';

    try {
      await pool.query(
        `INSERT INTO users (
           id, email, password_hash, email_verified, requested_role, onboarding_status
         ) VALUES ($1, $2, $3, true, 'trainer', 'survey_pending')`,
        [userId, email, passwordHash],
      );
      const request = await pool.query<{ readonly id: string }>(
        `INSERT INTO trainer_verification_requests (user_id, status)
         VALUES ($1, 'pending')
         RETURNING id`,
        [userId],
      );

      const beforeSubmission = await repository.findByUserId(userId);
      assert.equal(beforeSubmission?.requestedRole, 'trainer');
      assert.equal(beforeSubmission?.trainerVerificationState, 'not_started');
      assert.equal(beforeSubmission?.accountRole, 'client');
      assert.equal(beforeSubmission?.trainerProfile, null);

      await pool.query(
        `UPDATE trainer_verification_requests
         SET display_name = 'Profile Role Trainer',
             specialization = 'Mobility',
             experience_years = 5,
             bio = 'Long enough profile verification biography.',
             city = 'Moscow',
             timezone = 'Europe/Moscow',
             submitted_at = NOW()
         WHERE id = $1`,
        [request.rows[0]?.id],
      );

      const pending = await repository.findByUserId(userId);
      assert.equal(pending?.requestedRole, 'trainer');
      assert.equal(pending?.trainerVerificationState, 'pending');
      assert.equal(pending?.accountRole, 'client');
      assert.equal(pending?.trainerProfile, null);

      await pool.query(
        `INSERT INTO trainer_profiles (
           user_id, display_name, is_active, is_default, can_manage_videos
         ) VALUES ($1, 'Profile Role Trainer', true, false, false)`,
        [userId],
      );

      const approvedAuthority = await repository.findByUserId(userId);
      assert.equal(approvedAuthority?.requestedRole, 'trainer');
      assert.equal(approvedAuthority?.trainerVerificationState, 'approved');
      assert.equal(approvedAuthority?.accountRole, 'trainer');
      assert.equal(approvedAuthority?.trainerProfile?.displayName, 'Profile Role Trainer');
      assert.equal(approvedAuthority?.trainerProfile?.canManageVideos, false);
      console.log('KINETRA_REGISTRATION_PROFILE_POSTGRES17=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      await pool.end();
    }
  },
);
