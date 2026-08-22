import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresPushRepository } from '../src/push/postgres-push.repository.js';
import { MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER } from '../src/push/repository.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

test(
  'PostgreSQL Push repository filters onboarding, owns endpoints, claims once and classifies delivery state',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PostgresPushRepository(pool);
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    const incompleteUsers = [
      { id: randomUUID(), status: 'survey_pending' },
      { id: randomUUID(), status: 'onboarding_pending' },
      { id: randomUUID(), status: 'base_lessons' },
    ] as const;
    const endpoint = `https://push.example.test/${randomUUID()}`;
    const secondEndpoint = `https://push.example.test/${randomUUID()}`;
    const now = new Date('2026-08-23T06:00:00.000Z');

    try {
      const schema = await pool.query<{ readonly table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN ('push_subscriptions', 'push_notification_deliveries')
         ORDER BY table_name`,
      );
      assert.deepEqual(
        schema.rows.map(({ table_name: tableName }) => tableName),
        ['push_notification_deliveries', 'push_subscriptions'],
      );

      await pool.query(
        `INSERT INTO users (
           id,
           email,
           password_hash,
           onboarding_status,
           timezone,
           notification_preferences
         )
         VALUES
           ($1, $2, $3, 'active', 'Europe/Moscow', $5::jsonb),
           ($4, $6, $3, 'active', 'Invalid/Timezone', $5::jsonb)`,
        [
          firstUserId,
          `push-${firstUserId}@example.com`,
          '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
          secondUserId,
          JSON.stringify({
            workout_reminders: true,
            reminder_time: '09:00',
            weekly_survey_reminder: true,
          }),
          `push-${secondUserId}@example.com`,
        ],
      );

      for (const user of incompleteUsers) {
        await pool.query(
          `INSERT INTO users (
             id,
             email,
             password_hash,
             onboarding_status,
             timezone,
             notification_preferences
           )
           VALUES ($1, $2, $3, $4, 'Europe/Moscow', $5::jsonb)`,
          [
            user.id,
            `push-${user.id}@example.com`,
            '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
            user.status,
            JSON.stringify({
              workout_reminders: true,
              reminder_time: '09:00',
              weekly_survey_reminder: true,
            }),
          ],
        );
        assert.equal(
          await repository.upsertSubscription({
            userId: user.id,
            endpoint: `https://push.example.test/${randomUUID()}`,
            p256dh: 'I'.repeat(87),
            auth: 'J'.repeat(22),
            expirationTime: null,
            userAgent: null,
          }),
          true,
        );
      }

      assert.equal(
        await repository.upsertSubscription({
          userId: firstUserId,
          endpoint,
          p256dh: 'A'.repeat(87),
          auth: 'B'.repeat(22),
          expirationTime: null,
          userAgent: 'First browser',
        }),
        true,
      );
      for (const keys of [
        { p256dh: 'A'.repeat(87), auth: 'D'.repeat(22) },
        { p256dh: 'C'.repeat(87), auth: 'B'.repeat(22) },
      ]) {
        assert.equal(
          await repository.upsertSubscription({
            userId: secondUserId,
            endpoint,
            ...keys,
            expirationTime: null,
            userAgent: 'Second browser',
          }),
          false,
        );
      }
      const rejectedTransfer = await pool.query<{
        readonly user_id: string;
        readonly p256dh: string;
        readonly auth: string;
        readonly user_agent: string | null;
        readonly total: number;
      }>(
        `SELECT user_id, p256dh, auth, user_agent, COUNT(*) OVER ()::integer AS total
         FROM push_subscriptions
         WHERE endpoint = $1`,
        [endpoint],
      );
      assert.deepEqual(rejectedTransfer.rows[0], {
        user_id: firstUserId,
        p256dh: 'A'.repeat(87),
        auth: 'B'.repeat(22),
        user_agent: 'First browser',
        total: 1,
      });

      assert.equal(
        await repository.upsertSubscription({
          userId: secondUserId,
          endpoint,
          p256dh: 'A'.repeat(87),
          auth: 'B'.repeat(22),
          expirationTime: null,
          userAgent: 'Second browser',
        }),
        true,
      );
      const transferred = await pool.query<{
        readonly user_id: string;
        readonly p256dh: string;
        readonly auth: string;
        readonly user_agent: string | null;
        readonly total: number;
      }>(
        `SELECT user_id, p256dh, auth, user_agent, COUNT(*) OVER ()::integer AS total
         FROM push_subscriptions
         WHERE endpoint = $1`,
        [endpoint],
      );
      assert.deepEqual(transferred.rows[0], {
        user_id: secondUserId,
        p256dh: 'A'.repeat(87),
        auth: 'B'.repeat(22),
        user_agent: 'Second browser',
        total: 1,
      });

      await repository.disableSubscription(firstUserId, endpoint, now);
      assert.equal(
        (
          await pool.query<{ readonly disabled_at: Date | null }>(
            'SELECT disabled_at FROM push_subscriptions WHERE endpoint = $1',
            [endpoint],
          )
        ).rows[0]?.disabled_at,
        null,
      );

      await repository.upsertSubscription({
        userId: secondUserId,
        endpoint: secondEndpoint,
        p256dh: 'E'.repeat(87),
        auth: 'F'.repeat(22),
        expirationTime: null,
        userAgent: null,
      });
      const due = await repository.findDueUsers(now);
      assert.deepEqual(due, [
        {
          userId: secondUserId,
          effectiveTimezone: 'Europe/Moscow',
          localDate: '2026-08-23',
          localDayOfWeek: 7,
          workoutReminders: true,
          weeklySurveyReminder: true,
        },
      ]);

      const event = {
        userId: secondUserId,
        notificationType: 'weekly_survey_reminder',
        occurrenceKey: 'weekly-survey:1',
      } as const;
      const concurrentClaims = await Promise.all([
        repository.claimDeliveries(event, now),
        repository.claimDeliveries(event, now),
      ]);
      assert.equal(
        concurrentClaims.reduce((total, result) => total + result.claims.length, 0),
        2,
      );
      assert.equal(
        concurrentClaims.reduce((total, result) => total + result.duplicates, 0),
        2,
      );
      const claims = concurrentClaims.flatMap(({ claims: resultClaims }) => resultClaims);
      assert.equal(claims.length, 2);

      const invalidated = await repository.executeDeliveryClaim(claims[0]!, now, async () => ({
        kind: 'invalid',
        errorCode: 'http_410',
      }));
      assert.equal(invalidated, 'invalidated');
      const invalidatedSubscription = await pool.query<{
        readonly disabled_at: Date | null;
        readonly last_failure_at: Date | null;
      }>('SELECT disabled_at, last_failure_at FROM push_subscriptions WHERE id = $1', [
        claims[0]?.subscriptionId,
      ]);
      assert.equal(invalidatedSubscription.rows[0]?.disabled_at instanceof Date, true);
      assert.equal(invalidatedSubscription.rows[0]?.last_failure_at instanceof Date, true);

      const failed = await repository.executeDeliveryClaim(claims[1]!, now, async () => ({
        kind: 'failed',
        errorCode: 'http_503',
      }));
      assert.equal(failed, 'failed');
      const transientSubscription = await pool.query<{
        readonly disabled_at: Date | null;
        readonly last_failure_at: Date | null;
      }>('SELECT disabled_at, last_failure_at FROM push_subscriptions WHERE id = $1', [
        claims[1]?.subscriptionId,
      ]);
      assert.equal(transientSubscription.rows[0]?.disabled_at, null);
      assert.equal(transientSubscription.rows[0]?.last_failure_at instanceof Date, true);

      const repeated = await repository.claimDeliveries(event, now);
      assert.equal(repeated.claims.length, 0);
      assert.equal(repeated.duplicates, 1);

      await pool.query('DELETE FROM users WHERE id = $1', [secondUserId]);
      const cascaded = await pool.query<{
        readonly subscriptions: number;
        readonly deliveries: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::integer FROM push_subscriptions WHERE user_id = $1) AS subscriptions,
           (
             SELECT COUNT(*)::integer
             FROM push_notification_deliveries
             WHERE user_id = $1
           ) AS deliveries`,
        [secondUserId],
      );
      assert.deepEqual(cascaded.rows[0], { subscriptions: 0, deliveries: 0 });
      console.log('KINETRA_T13_POSTGRES_INTEGRATION=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        [firstUserId, secondUserId, ...incompleteUsers.map(({ id }) => id)],
      ]);
      await pool.end();
    }
  },
);

test(
  'PostgreSQL Push repository atomically caps enabled devices and preserves rejected transfers',
  {
    skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false,
    timeout: 20_000,
  },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 12 });
    const repository = new PostgresPushRepository(pool);
    const targetUserId = randomUUID();
    const sourceUserId = randomUUID();
    const targetEndpoints = Array.from(
      { length: MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER - 1 },
      (_, index) => `https://push.example.test/cap-${randomUUID()}-${index}`,
    );
    const sourceEndpoint = `https://push.example.test/transfer-${randomUUID()}`;
    const replacementEndpoint = `https://push.example.test/replacement-${randomUUID()}`;
    const subscription = (
      userId: string,
      endpoint: string,
      overrides: Partial<{
        readonly p256dh: string;
        readonly auth: string;
        readonly expirationTime: Date | null;
        readonly userAgent: string | null;
      }> = {},
    ) => ({
      userId,
      endpoint,
      p256dh: 'A'.repeat(87),
      auth: 'B'.repeat(22),
      expirationTime: null,
      userAgent: null,
      ...overrides,
    });
    const enabledCount = async (userId: string): Promise<number> => {
      const result = await pool.query<{ readonly total: number }>(
        `SELECT COUNT(*)::integer AS total
         FROM push_subscriptions
         WHERE user_id = $1
           AND disabled_at IS NULL`,
        [userId],
      );
      return result.rows[0]?.total ?? 0;
    };

    try {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, onboarding_status)
         VALUES
           ($1, $2, $3, 'active'),
           ($4, $5, $3, 'active')`,
        [
          targetUserId,
          `push-cap-${targetUserId}@example.com`,
          '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
          sourceUserId,
          `push-cap-${sourceUserId}@example.com`,
        ],
      );

      for (const [index, endpoint] of targetEndpoints.entries()) {
        assert.equal(
          await repository.upsertSubscription(
            subscription(targetUserId, endpoint, {
              expirationTime: index === 0 ? new Date(0) : null,
              userAgent: `Target browser ${index}`,
            }),
          ),
          true,
        );
      }
      assert.equal(
        await repository.upsertSubscription(
          subscription(sourceUserId, sourceEndpoint, {
            p256dh: 'S'.repeat(87),
            auth: 'T'.repeat(22),
            userAgent: 'Source browser',
          }),
        ),
        true,
      );

      const concurrentResults = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          repository.upsertSubscription(
            subscription(
              targetUserId,
              `https://push.example.test/concurrent-${randomUUID()}-${index}`,
            ),
          ),
        ),
      );
      assert.equal(concurrentResults.filter(Boolean).length, 1);
      assert.equal(await enabledCount(targetUserId), MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER);

      assert.equal(
        await repository.upsertSubscription(
          subscription(targetUserId, targetEndpoints[1]!, {
            p256dh: 'R'.repeat(87),
            auth: 'Q'.repeat(22),
            userAgent: 'Rotated at capacity',
          }),
        ),
        true,
      );
      assert.equal(await enabledCount(targetUserId), MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER);

      await repository.disableSubscription(targetUserId, targetEndpoints[0]!, new Date());
      assert.equal(
        await repository.upsertSubscription(
          subscription(targetUserId, replacementEndpoint, { userAgent: 'Replacement browser' }),
        ),
        true,
      );
      assert.equal(
        await repository.upsertSubscription(
          subscription(targetUserId, targetEndpoints[0]!, {
            p256dh: 'X'.repeat(87),
            auth: 'Y'.repeat(22),
            userAgent: 'Rejected reactivation',
          }),
        ),
        false,
      );
      const rejectedReactivation = await pool.query<{
        readonly disabled_at: Date | null;
        readonly p256dh: string;
        readonly auth: string;
        readonly user_agent: string | null;
      }>(
        `SELECT disabled_at, p256dh, auth, user_agent
         FROM push_subscriptions
         WHERE endpoint = $1`,
        [targetEndpoints[0]],
      );
      assert.equal(rejectedReactivation.rows[0]?.disabled_at instanceof Date, true);
      assert.deepEqual(
        {
          p256dh: rejectedReactivation.rows[0]?.p256dh,
          auth: rejectedReactivation.rows[0]?.auth,
          userAgent: rejectedReactivation.rows[0]?.user_agent,
        },
        {
          p256dh: 'A'.repeat(87),
          auth: 'B'.repeat(22),
          userAgent: 'Target browser 0',
        },
      );

      await repository.disableSubscription(targetUserId, replacementEndpoint, new Date());
      assert.equal(
        await repository.upsertSubscription(
          subscription(targetUserId, targetEndpoints[0]!, {
            p256dh: 'X'.repeat(87),
            auth: 'Y'.repeat(22),
            userAgent: 'Reactivated browser',
          }),
        ),
        true,
      );
      assert.equal(await enabledCount(targetUserId), MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER);

      assert.equal(
        await repository.upsertSubscription(
          subscription(targetUserId, sourceEndpoint, {
            p256dh: 'S'.repeat(87),
            auth: 'T'.repeat(22),
            userAgent: 'Rejected transfer',
          }),
        ),
        false,
      );
      const rejectedTransfer = await pool.query<{
        readonly user_id: string;
        readonly p256dh: string;
        readonly auth: string;
        readonly user_agent: string | null;
      }>(
        `SELECT user_id, p256dh, auth, user_agent
         FROM push_subscriptions
         WHERE endpoint = $1`,
        [sourceEndpoint],
      );
      assert.deepEqual(rejectedTransfer.rows[0], {
        user_id: sourceUserId,
        p256dh: 'S'.repeat(87),
        auth: 'T'.repeat(22),
        user_agent: 'Source browser',
      });

      await repository.disableSubscription(targetUserId, targetEndpoints[1]!, new Date());
      assert.equal(
        await repository.upsertSubscription(
          subscription(targetUserId, sourceEndpoint, {
            p256dh: 'S'.repeat(87),
            auth: 'T'.repeat(22),
            userAgent: 'Transferred browser',
          }),
        ),
        true,
      );
      assert.equal(await enabledCount(targetUserId), MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER);
    } finally {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        [targetUserId, sourceUserId],
      ]);
      await pool.end();
    }
  },
);
