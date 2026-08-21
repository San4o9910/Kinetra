import type {
  NotificationPreferences,
  OnboardingStatus,
  SubscriptionProvider,
  SubscriptionStatus,
} from '@kinetra/shared';
import type { Pool, QueryResultRow } from 'pg';

import type {
  SettingsProfileSnapshot,
  SettingsRepository,
  SettingsSubscriptionLookup,
  SettingsSubscriptionSnapshot,
} from './repository.js';

interface ProfileRow extends QueryResultRow {
  readonly email: string | null;
  readonly phone: string | null;
  readonly created_at: Date | string;
  readonly onboarding_status: OnboardingStatus;
  readonly notification_enabled: boolean;
  readonly notification_preferences: unknown;
}

interface SubscriptionRow extends QueryResultRow {
  readonly user_id: string;
  readonly subscription_id: string | null;
  readonly provider: SubscriptionProvider | null;
  readonly status: SubscriptionStatus | null;
  readonly starts_at: Date | string | null;
  readonly expires_at: Date | string | null;
  readonly amount_minor: number | null;
  readonly currency: string | null;
  readonly auto_renew: boolean | null;
}

const asDate = (value: Date | string): Date =>
  value instanceof Date ? new Date(value.getTime()) : new Date(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isReminderTime = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);

const normalizeNotificationPreferences = (
  value: unknown,
  notificationEnabled: boolean,
): NotificationPreferences => {
  const preferences = isRecord(value) ? value : {};

  return {
    workout_reminders:
      typeof preferences.workout_reminders === 'boolean'
        ? preferences.workout_reminders
        : notificationEnabled,
    reminder_time: isReminderTime(preferences.reminder_time) ? preferences.reminder_time : '09:00',
    weekly_survey_reminder:
      typeof preferences.weekly_survey_reminder === 'boolean'
        ? preferences.weekly_survey_reminder
        : true,
  };
};

const mapSubscription = (row: SubscriptionRow): SettingsSubscriptionSnapshot | null => {
  if (row.subscription_id === null || row.provider === null || row.status === null) {
    return null;
  }

  return {
    provider: row.provider,
    status: row.status,
    startsAt: row.starts_at === null ? null : asDate(row.starts_at),
    expiresAt: row.expires_at === null ? null : asDate(row.expires_at),
    amountMinor: row.amount_minor,
    currency: row.currency,
    autoRenew: row.auto_renew ?? false,
  };
};

export class PostgresSettingsRepository implements SettingsRepository {
  public constructor(private readonly pool: Pool) {}

  public async findProfileByUserId(userId: string): Promise<SettingsProfileSnapshot | null> {
    const result = await this.pool.query<ProfileRow>(
      `SELECT
         email,
         phone,
         created_at,
         onboarding_status,
         notification_enabled,
         notification_preferences
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return null;
    }

    return {
      email: row.email,
      phone: row.phone,
      createdAt: asDate(row.created_at),
      onboardingStatus: row.onboarding_status,
      notificationPreferences: normalizeNotificationPreferences(
        row.notification_preferences,
        row.notification_enabled,
      ),
    };
  }

  public async findSubscriptionByUserId(
    userId: string,
    now: Date,
  ): Promise<SettingsSubscriptionLookup> {
    const result = await this.pool.query<SubscriptionRow>(
      `SELECT
         user_record.id AS user_id,
         subscription.id AS subscription_id,
         subscription.provider,
         subscription.status,
         subscription.starts_at,
         subscription.expires_at,
         subscription.amount_minor,
         subscription.currency,
         subscription.auto_renew
       FROM users AS user_record
       LEFT JOIN LATERAL (
         SELECT
           id,
           provider,
           status,
           starts_at,
           expires_at,
           amount_minor,
           currency,
           auto_renew,
           created_at
         FROM subscriptions
         WHERE user_id = user_record.id
         ORDER BY
           (
             status = 'active'
             AND (starts_at IS NULL OR starts_at <= $2)
             AND (expires_at IS NULL OR expires_at > $2)
           ) DESC,
           created_at DESC,
           id DESC
         LIMIT 1
       ) AS subscription ON true
       WHERE user_record.id = $1
       LIMIT 1`,
      [userId, now],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return { userExists: false, subscription: null };
    }

    return { userExists: true, subscription: mapSubscription(row) };
  }

  public async updateNotificationPreferences(
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE users
       SET notification_preferences = $2::jsonb,
           notification_enabled = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, JSON.stringify(preferences), preferences.workout_reminders],
    );

    return result.rowCount === 1;
  }

  public async deleteAccount(userId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
    return result.rowCount === 1;
  }
}
