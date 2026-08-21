import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresAuthRepository } from '../src/auth/postgres-auth.repository.js';
import type { Clock } from '../src/auth/service.js';
import { PostgresSettingsRepository } from '../src/settings/postgres-settings.repository.js';
import { SettingsService } from '../src/settings/service.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

class FixedClock implements Clock {
  public constructor(private readonly value: Date) {}

  public now(): Date {
    return new Date(this.value.getTime());
  }
}

test(
  'PostgreSQL settings repository persists preferences and deletes account-owned data',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const email = `settings-${userId}@example.com`;
    const otherEmail = `settings-other-${otherUserId}@example.com`;
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';
    const now = new Date('2026-08-21T00:00:00.000Z');
    const repository = new PostgresSettingsRepository(pool);
    const service = new SettingsService(repository, new FixedClock(now));

    try {
      await pool.query(
        `INSERT INTO users (
           id, email, password_hash, email_verified, onboarding_status, notification_enabled
         )
         VALUES
           ($1, $2, $3, true, 'active', true),
           ($4, $5, $3, true, 'active', false)`,
        [userId, email, passwordHash, otherUserId, otherEmail],
      );
      await pool.query(
        `INSERT INTO subscriptions (
           user_id,
           provider,
           provider_subscription_id,
           status,
           starts_at,
           expires_at,
           amount_minor,
           currency,
           auto_renew
         )
         VALUES ($1, 'yukassa', $2, 'active', $3, $4, 79900, 'RUB', true)`,
        [
          userId,
          `settings-${userId}`,
          new Date('2026-08-20T00:00:00.000Z'),
          new Date('2026-09-15T00:00:00.000Z'),
        ],
      );
      await pool.query(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), userId, 'a'.repeat(64), new Date('2026-09-21T00:00:00.000Z'), now],
      );
      await pool.query(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), userId, 'b'.repeat(64), new Date('2026-08-22T00:00:00.000Z'), now],
      );
      await pool.query(
        `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), userId, 'c'.repeat(64), new Date('2026-08-22T00:00:00.000Z'), now],
      );

      const initialProfile = await service.getProfile(userId);
      assert.deepEqual(initialProfile.notification_preferences, {
        workout_reminders: true,
        reminder_time: '09:00',
        weekly_survey_reminder: true,
      });

      const subscription = await service.getSubscription(userId);
      assert.deepEqual(subscription, {
        status: 'active',
        provider: 'yukassa',
        starts_at: '2026-08-20T00:00:00.000Z',
        expires_at: '2026-09-15T00:00:00.000Z',
        amount: 799,
        currency: 'RUB',
        auto_renew: true,
        days_remaining: 25,
      });

      await service.updateNotifications(userId, {
        workout_reminders: false,
        reminder_time: '23:59',
        weekly_survey_reminder: false,
      });
      const saved = await pool.query<{
        readonly notification_enabled: boolean;
        readonly notification_preferences: unknown;
      }>(
        `SELECT notification_enabled, notification_preferences
         FROM users
         WHERE id = $1`,
        [userId],
      );
      assert.equal(saved.rows[0]?.notification_enabled, false);
      assert.deepEqual(saved.rows[0]?.notification_preferences, {
        workout_reminders: false,
        reminder_time: '23:59',
        weekly_survey_reminder: false,
      });

      await pool.query("UPDATE subscriptions SET status = 'refunded' WHERE user_id = $1", [userId]);
      assert.equal((await service.getSubscription(userId)).status, 'cancelled');

      await assert.rejects(
        pool.query('UPDATE users SET notification_preferences = $2::jsonb WHERE id = $1', [
          userId,
          '[]',
        ]),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'constraint' in error &&
          (error as { readonly constraint?: unknown }).constraint ===
            'users_notification_preferences_object',
      );

      await service.deleteAccount(userId, { confirm: 'DELETE' });

      for (const table of [
        'users',
        'subscriptions',
        'refresh_tokens',
        'password_reset_tokens',
        'email_verification_tokens',
      ]) {
        const count = await pool.query<{ readonly count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'} = $1`,
          [userId],
        );
        assert.equal(count.rows[0]?.count, '0', table);
      }

      const authRepository = new PostgresAuthRepository(pool);
      assert.equal(await authRepository.findUserByEmail(email), null);
      assert.notEqual(await authRepository.findUserByEmail(otherEmail), null);
      console.log('KINETRA_T10_POSTGRES_INTEGRATION=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]);
      await pool.end();
    }
  },
);
