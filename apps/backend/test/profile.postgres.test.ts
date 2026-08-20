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
      console.log('KINETRA_T04_POSTGRES_INTEGRATION=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      await pool.end();
    }
  },
);
