import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER,
  type DuePushUser,
  type PushDeliveryClaim,
  type PushDeliveryClaimResult,
  type PushDeliveryExecutionResult,
  type PushDeviceSubscription,
  type PushNotificationEvent,
  type PushNotificationType,
  type PushRepository,
  type PushSendResult,
  type PushSubscriptionInput,
} from './repository.js';

interface DueUserRow extends QueryResultRow {
  readonly user_id: string;
  readonly effective_timezone: string;
  readonly local_date: string;
  readonly local_day_of_week: number;
  readonly workout_reminders: boolean;
  readonly weekly_survey_reminder: boolean;
}

interface ClaimRow extends QueryResultRow {
  readonly eligible_count: number | string;
  readonly id: string | null;
  readonly subscription_id: string | null;
  readonly user_id: string | null;
  readonly notification_type: PushNotificationType | null;
  readonly occurrence_key: string | null;
}

interface ExecutableClaimRow extends QueryResultRow {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly expiration_time: Date | string | null;
}

interface ExistingSubscriptionRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly disabled_at: Date | string | null;
}

interface EnabledSubscriptionCountRow extends QueryResultRow {
  readonly enabled_count: number | string;
}

const integerFrom = (value: number | string, label: string): number => {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }

  return parsed;
};

const dateFrom = (value: Date | string): Date =>
  value instanceof Date ? new Date(value.getTime()) : new Date(value);

const safeErrorCode = (value: string): string =>
  /^[a-z0-9_]{1,64}$/u.test(value) ? value : 'sender_error';

const rollbackQuietly = async (client: PoolClient): Promise<void> => {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    console.error('Failed to roll back a push notification transaction.', rollbackError);
  }
};

export class PostgresPushRepository implements PushRepository {
  public constructor(private readonly pool: Pool) {}

  public async upsertSubscription(input: PushSubscriptionInput): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const user = await client.query(
        `SELECT id
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [input.userId],
      );

      if (user.rowCount !== 1) {
        await client.query('COMMIT');
        return false;
      }

      let existingResult = await client.query<ExistingSubscriptionRow>(
        `SELECT id, user_id, p256dh, auth, disabled_at
         FROM push_subscriptions
         WHERE endpoint = $1
         FOR UPDATE`,
        [input.endpoint],
      );
      let existing = existingResult.rows[0];

      if (
        existing !== undefined &&
        existing.user_id !== input.userId &&
        (existing.p256dh !== input.p256dh || existing.auth !== input.auth)
      ) {
        await client.query('COMMIT');
        return false;
      }

      const hasEnabledSlot = async (): Promise<boolean> => {
        const countResult = await client.query<EnabledSubscriptionCountRow>(
          `SELECT COUNT(*)::integer AS enabled_count
           FROM push_subscriptions
           WHERE user_id = $1
             AND disabled_at IS NULL`,
          [input.userId],
        );
        const enabledCount = integerFrom(
          countResult.rows[0]?.enabled_count ?? 0,
          'enabled push subscription count',
        );

        return enabledCount < MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER;
      };
      const requiresEnabledSlot =
        existing === undefined ||
        existing.user_id !== input.userId ||
        existing.disabled_at !== null;

      if (requiresEnabledSlot && !(await hasEnabledSlot())) {
        await client.query('COMMIT');
        return false;
      }

      if (existing === undefined) {
        const inserted = await client.query(
          `INSERT INTO push_subscriptions (
           user_id,
           endpoint,
           p256dh,
           auth,
           expiration_time,
           user_agent,
           disabled_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, NULL)
         ON CONFLICT (endpoint)
         DO NOTHING
         RETURNING id`,
          [
            input.userId,
            input.endpoint,
            input.p256dh,
            input.auth,
            input.expirationTime,
            input.userAgent,
          ],
        );

        if (inserted.rowCount === 1) {
          await client.query('COMMIT');
          return true;
        }

        existingResult = await client.query<ExistingSubscriptionRow>(
          `SELECT id, user_id, p256dh, auth, disabled_at
           FROM push_subscriptions
           WHERE endpoint = $1
           FOR UPDATE`,
          [input.endpoint],
        );
        existing = existingResult.rows[0];

        if (
          existing === undefined ||
          (existing.user_id !== input.userId &&
            (existing.p256dh !== input.p256dh || existing.auth !== input.auth))
        ) {
          await client.query('COMMIT');
          return false;
        }

        const stillRequiresEnabledSlot =
          existing.user_id !== input.userId || existing.disabled_at !== null;

        if (stillRequiresEnabledSlot && !(await hasEnabledSlot())) {
          await client.query('COMMIT');
          return false;
        }
      }

      const updated = await client.query(
        `UPDATE push_subscriptions
         SET user_id = $1,
             p256dh = $3,
             auth = $4,
             expiration_time = $5,
             user_agent = $6,
             disabled_at = NULL
         WHERE id = $2`,
        [
          input.userId,
          existing.id,
          input.p256dh,
          input.auth,
          input.expirationTime,
          input.userAgent,
        ],
      );
      await client.query('COMMIT');
      return updated.rowCount === 1;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async disableSubscription(userId: string, endpoint: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE push_subscriptions
       SET disabled_at = COALESCE(disabled_at, $3)
       WHERE user_id = $1
         AND endpoint = $2`,
      [userId, endpoint, now],
    );
  }

  public async findDueUsers(now: Date): Promise<readonly DuePushUser[]> {
    const result = await this.pool.query<DueUserRow>(
      `WITH normalized AS (
         SELECT
           user_record.id AS user_id,
           COALESCE(timezone_entry.name, 'Europe/Moscow') AS effective_timezone,
           CASE
             WHEN jsonb_typeof(
               user_record.notification_preferences -> 'workout_reminders'
             ) = 'boolean'
             THEN (
               user_record.notification_preferences ->> 'workout_reminders'
             )::boolean
             ELSE user_record.notification_enabled
           END AS workout_reminders,
           CASE
             WHEN (
               user_record.notification_preferences ->> 'reminder_time'
             ) ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
             THEN user_record.notification_preferences ->> 'reminder_time'
             ELSE '09:00'
           END AS reminder_time,
           CASE
             WHEN jsonb_typeof(
               user_record.notification_preferences -> 'weekly_survey_reminder'
             ) = 'boolean'
             THEN (
               user_record.notification_preferences ->> 'weekly_survey_reminder'
             )::boolean
             ELSE true
           END AS weekly_survey_reminder
         FROM users AS user_record
         LEFT JOIN pg_timezone_names AS timezone_entry
           ON timezone_entry.name = user_record.timezone
         WHERE user_record.onboarding_status = 'active'
           AND EXISTS (
           SELECT 1
           FROM push_subscriptions AS subscription
           WHERE subscription.user_id = user_record.id
             AND subscription.disabled_at IS NULL
             AND (
               subscription.expiration_time IS NULL
               OR subscription.expiration_time > $1
             )
         )
       ), localized AS (
         SELECT
           normalized.*,
           $1::timestamptz AT TIME ZONE normalized.effective_timezone AS local_now
         FROM normalized
       )
       SELECT
         user_id,
         effective_timezone,
         to_char(local_now, 'YYYY-MM-DD') AS local_date,
         EXTRACT(ISODOW FROM local_now)::integer AS local_day_of_week,
         workout_reminders,
         weekly_survey_reminder
       FROM localized
       WHERE to_char(local_now, 'HH24:MI') = reminder_time
         AND (
           workout_reminders
           OR (
             weekly_survey_reminder
             AND EXTRACT(ISODOW FROM local_now)::integer = 7
           )
         )
       ORDER BY user_id`,
      [now],
    );

    return result.rows.map((row) => ({
      userId: row.user_id,
      effectiveTimezone: row.effective_timezone,
      localDate: row.local_date,
      localDayOfWeek: integerFrom(row.local_day_of_week, 'local weekday'),
      workoutReminders: row.workout_reminders,
      weeklySurveyReminder: row.weekly_survey_reminder,
    }));
  }

  public async claimDeliveries(
    event: PushNotificationEvent,
    now: Date,
  ): Promise<PushDeliveryClaimResult> {
    const result = await this.pool.query<ClaimRow>(
      `WITH eligible AS MATERIALIZED (
         SELECT id, user_id
         FROM push_subscriptions
         WHERE user_id = $1
           AND disabled_at IS NULL
           AND (expiration_time IS NULL OR expiration_time > $4)
       ), inserted AS (
         INSERT INTO push_notification_deliveries (
           subscription_id,
           user_id,
           notification_type,
           occurrence_key,
           status,
           claimed_at
         )
         SELECT id, user_id, $2, $3, 'claimed', $4
         FROM eligible
         ON CONFLICT (
           subscription_id,
           user_id,
           notification_type,
           occurrence_key
         ) DO NOTHING
         RETURNING id, subscription_id, user_id, notification_type, occurrence_key
       ), stats AS (
         SELECT COUNT(*)::integer AS eligible_count
         FROM eligible
       )
       SELECT
         stats.eligible_count,
         inserted.id,
         inserted.subscription_id,
         inserted.user_id,
         inserted.notification_type,
         inserted.occurrence_key
       FROM stats
       LEFT JOIN inserted ON true
       ORDER BY inserted.id`,
      [event.userId, event.notificationType, event.occurrenceKey, now],
    );
    const claims: PushDeliveryClaim[] = [];

    for (const row of result.rows) {
      if (
        row.id !== null &&
        row.subscription_id !== null &&
        row.user_id !== null &&
        row.notification_type !== null &&
        row.occurrence_key !== null
      ) {
        claims.push({
          id: row.id,
          subscriptionId: row.subscription_id,
          userId: row.user_id,
          notificationType: row.notification_type,
          occurrenceKey: row.occurrence_key,
        });
      }
    }

    const eligible = integerFrom(result.rows[0]?.eligible_count ?? 0, 'eligible delivery count');
    return { claims, duplicates: Math.max(0, eligible - claims.length) };
  }

  public async executeDeliveryClaim(
    claim: PushDeliveryClaim,
    now: Date,
    send: (subscription: PushDeviceSubscription) => Promise<PushSendResult>,
  ): Promise<PushDeliveryExecutionResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const selected = await client.query<ExecutableClaimRow>(
        `SELECT
           subscription.endpoint,
           subscription.p256dh,
           subscription.auth,
           subscription.expiration_time
         FROM push_notification_deliveries AS delivery
         INNER JOIN push_subscriptions AS subscription
           ON subscription.id = delivery.subscription_id
          AND subscription.user_id = delivery.user_id
         WHERE delivery.id = $1
           AND delivery.subscription_id = $2
           AND delivery.user_id = $3
           AND delivery.notification_type = $4
           AND delivery.occurrence_key = $5
           AND delivery.status = 'claimed'
           AND subscription.disabled_at IS NULL
           AND (
             subscription.expiration_time IS NULL
             OR subscription.expiration_time > $6
           )
         FOR UPDATE OF delivery, subscription`,
        [
          claim.id,
          claim.subscriptionId,
          claim.userId,
          claim.notificationType,
          claim.occurrenceKey,
          now,
        ],
      );
      const row = selected.rows[0];

      if (row === undefined) {
        await client.query('COMMIT');
        return 'skipped';
      }

      const outcome = await send({
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        expirationTime: row.expiration_time === null ? null : dateFrom(row.expiration_time),
      });

      if (outcome.kind === 'sent') {
        await client.query(
          `UPDATE push_notification_deliveries
           SET status = 'sent',
               sent_at = $2,
               failed_at = NULL,
               error_code = NULL
           WHERE id = $1`,
          [claim.id, now],
        );
        await client.query(
          `UPDATE push_subscriptions
           SET last_success_at = $2
           WHERE id = $1`,
          [claim.subscriptionId, now],
        );
        await client.query('COMMIT');
        return 'sent';
      }

      if (outcome.kind === 'invalid') {
        await client.query(
          `UPDATE push_notification_deliveries
           SET status = 'invalidated',
               failed_at = $2,
               error_code = $3
           WHERE id = $1`,
          [claim.id, now, outcome.errorCode],
        );
        await client.query(
          `UPDATE push_subscriptions
           SET disabled_at = COALESCE(disabled_at, $2),
               last_failure_at = $2
           WHERE id = $1`,
          [claim.subscriptionId, now],
        );
        await client.query('COMMIT');
        return 'invalidated';
      }

      await client.query(
        `UPDATE push_notification_deliveries
         SET status = 'failed',
             failed_at = $2,
             error_code = $3
         WHERE id = $1`,
        [claim.id, now, safeErrorCode(outcome.errorCode)],
      );
      await client.query(
        `UPDATE push_subscriptions
         SET last_failure_at = $2
         WHERE id = $1`,
        [claim.subscriptionId, now],
      );
      await client.query('COMMIT');
      return 'failed';
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
