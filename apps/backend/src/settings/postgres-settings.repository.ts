import type {
  NotificationPreferences,
  OnboardingStatus,
  SubscriptionProvider,
  SubscriptionStatus,
} from '@kinetra/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

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

const rollbackQuietly = async (client: PoolClient): Promise<void> => {
  try {
    await client.query('ROLLBACK');
  } catch {
    console.error('Failed to roll back an account deletion transaction.');
  }
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

  public async deleteAccount(userId: string): Promise<'deleted' | 'not_found' | 'trainer_managed'> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const user = await client.query(
        `SELECT id
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [userId],
      );
      const row = user.rows[0] as { readonly id: string } | undefined;

      if (row === undefined) {
        await client.query('COMMIT');
        return 'not_found';
      }

      const trainer = await client.query(
        `SELECT user_id
         FROM trainer_profiles
         WHERE user_id = $1
         FOR UPDATE`,
        [userId],
      );

      if (trainer.rowCount === 1) {
        const managedChat = await client.query<{ readonly managed: boolean }>(
          `SELECT
             EXISTS (
               SELECT 1
               FROM chat_conversations
               WHERE trainer_user_id = $1
             ) OR EXISTS (
               SELECT 1
               FROM chat_messages
               WHERE sender_user_id = $1
             ) AS managed`,
          [userId],
        );

        if (managedChat.rows[0]?.managed === true) {
          await client.query('COMMIT');
          return 'trainer_managed';
        }
      }

      await client.query(
        `INSERT INTO chat_media_deletion_jobs (object_key, requested_at, next_attempt_at)
         SELECT photo.object_key, NOW(), NOW()
         FROM chat_photos AS photo
         JOIN chat_conversations AS conversation ON conversation.id = photo.conversation_id
         WHERE conversation.client_user_id = $1 OR conversation.trainer_user_id = $1
         ON CONFLICT (object_key) DO NOTHING`,
        [userId],
      );
      const cancelledVideoUploads = await client.query<{
        readonly id: string;
        readonly object_key: string;
        readonly s3_version_id: string | null;
        readonly s3_multipart_upload_id: string | null;
      }>(
        `UPDATE trainer_video_uploads
         SET status = 'cancelled',
             cancelled_at = NOW(),
             completed_at = COALESCE(completed_at, NOW()),
             lease_token = NULL,
             lease_expires_at = NULL
         WHERE uploader_user_id = $1
           AND status IN (
             'creating','uploading','completing','verification_pending','verifying',
             'verification_quarantined'
           )
         RETURNING id, object_key, s3_version_id, s3_multipart_upload_id`,
        [userId],
      );
      for (const upload of cancelledVideoUploads.rows) {
        await client.query(
          `INSERT INTO video_media_deletion_jobs (
             object_key, s3_version_id, reason, upload_id, abort_multipart_upload_id,
             requested_at, not_before, next_attempt_at
           ) VALUES ($1,$2,'cancelled_upload',$3,$4,NOW(),NOW() + INTERVAL '16 minutes',NOW() + INTERVAL '16 minutes')
           ON CONFLICT (object_key, (COALESCE(s3_version_id, ''))) DO UPDATE SET
             abort_multipart_upload_id=COALESCE(
               video_media_deletion_jobs.abort_multipart_upload_id,
               EXCLUDED.abort_multipart_upload_id
             ),
             not_before=GREATEST(video_media_deletion_jobs.not_before, EXCLUDED.not_before),
             next_attempt_at=GREATEST(
               video_media_deletion_jobs.next_attempt_at,
               EXCLUDED.next_attempt_at
             )`,
          [upload.object_key, upload.s3_version_id, upload.id, upload.s3_multipart_upload_id],
        );
      }
      await client.query(
        `UPDATE trainer_video_uploads
         SET uploader_display_name_snapshot = NULL
         WHERE uploader_user_id = $1`,
        [userId],
      );
      const deleted = await client.query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
      await client.query('COMMIT');
      return deleted.rowCount === 1 ? 'deleted' : 'not_found';
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
