import type { SubscriptionProvider, SubscriptionStatus } from '@kinetra/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  ApplyPaymentEventResult,
  AttachProviderPaymentInput,
  AttachProviderPaymentResult,
  ClaimInitialPaymentInput,
  InitialPaymentClaim,
  PaymentAttemptKind,
  PaymentAttemptSnapshot,
  PaymentAttemptStatus,
  PaymentSubscriptionSnapshot,
  PaymentsRepository,
  RenewalClaim,
  RenewalClaimExecutionResult,
  RenewalProviderPayment,
  SubscriptionLookup,
  TerminalPaymentAttemptStatus,
  VerifiedPaymentEvent,
} from './repository.js';

interface AttemptRow extends QueryResultRow {
  readonly id: string;
  readonly subscription_id: string;
  readonly user_id: string;
  readonly provider_payment_id: string | null;
  readonly kind: PaymentAttemptKind;
  readonly status: PaymentAttemptStatus;
  readonly idempotency_key: string;
  readonly renews_expires_at: Date | string | null;
  readonly return_url: string | null;
  readonly confirmation_url: string | null;
}

interface SubscriptionRow extends QueryResultRow {
  readonly id: string;
  readonly user_id: string;
  readonly provider: SubscriptionProvider;
  readonly status: SubscriptionStatus;
  readonly starts_at: Date | string | null;
  readonly expires_at: Date | string | null;
  readonly amount_minor: number | null;
  readonly currency: string | null;
  readonly auto_renew: boolean;
  readonly payment_method_id: string | null;
}

interface RenewalRow extends AttemptRow {
  readonly payment_method_id: string;
}

interface EventAttemptRow extends QueryResultRow {
  readonly attempt_id: string;
  readonly attempt_kind: PaymentAttemptKind;
  readonly attempt_status: PaymentAttemptStatus;
  readonly provider_payment_id: string | null;
  readonly subscription_id: string;
  readonly subscription_status: SubscriptionStatus;
  readonly expires_at: Date | string | null;
}

const asDate = (value: Date | string): Date =>
  value instanceof Date ? new Date(value.getTime()) : new Date(value);

const mapAttempt = (row: AttemptRow): PaymentAttemptSnapshot => ({
  id: row.id,
  subscriptionId: row.subscription_id,
  userId: row.user_id,
  providerPaymentId: row.provider_payment_id,
  kind: row.kind,
  status: row.status,
  idempotencyKey: row.idempotency_key,
  renewsExpiresAt: row.renews_expires_at === null ? null : asDate(row.renews_expires_at),
  returnUrl: row.return_url,
  confirmationUrl: row.confirmation_url,
});

const mapSubscription = (row: SubscriptionRow): PaymentSubscriptionSnapshot => ({
  id: row.id,
  userId: row.user_id,
  provider: row.provider,
  status: row.status,
  startsAt: row.starts_at === null ? null : asDate(row.starts_at),
  expiresAt: row.expires_at === null ? null : asDate(row.expires_at),
  amountMinor: row.amount_minor,
  currency: row.currency,
  autoRenew: row.auto_renew,
  paymentMethodId: row.payment_method_id,
});

const rollbackQuietly = async (client: PoolClient): Promise<void> => {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    console.error('Failed to roll back a payments transaction.', rollbackError);
  }
};

const isTerminalAttemptStatus = (
  status: PaymentAttemptStatus,
): status is TerminalPaymentAttemptStatus =>
  status === 'succeeded' || status === 'cancelled' || status === 'refunded' || status === 'failed';

export class PostgresPaymentsRepository implements PaymentsRepository {
  public constructor(private readonly pool: Pool) {}

  public async claimInitialPayment(input: ClaimInitialPaymentInput): Promise<InitialPaymentClaim> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [
        input.userId,
      ]);

      if (user.rowCount !== 1) {
        await client.query('COMMIT');
        return { kind: 'user_not_found' };
      }

      const active = await client.query(
        `SELECT id
         FROM subscriptions
         WHERE user_id = $1
           AND status = 'active'
           AND starts_at IS NOT NULL
           AND starts_at <= $2
           AND expires_at IS NOT NULL
           AND expires_at > $2
         LIMIT 1`,
        [input.userId, input.now],
      );

      if (active.rowCount === 1) {
        await client.query('COMMIT');
        return { kind: 'subscription_active' };
      }

      const existing = await client.query<AttemptRow>(
        `SELECT
           id,
           subscription_id,
           user_id,
           provider_payment_id,
           kind,
           status,
           idempotency_key,
           renews_expires_at,
           return_url,
           confirmation_url
         FROM subscription_payment_attempts
         WHERE user_id = $1
           AND kind = 'initial'
           AND status IN ('creating', 'pending')
         ORDER BY created_at DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [input.userId],
      );
      const existingAttempt = existing.rows[0];

      if (existingAttempt !== undefined) {
        await client.query('COMMIT');
        return { kind: 'claimed', attempt: mapAttempt(existingAttempt) };
      }

      const subscription = await client.query<{ readonly id: string }>(
        `INSERT INTO subscriptions (
           user_id,
           provider,
           status,
           amount_minor,
           currency,
           auto_renew,
           raw_payload
         )
         VALUES ($1, 'yukassa', 'pending', $2, $3, true, '{}'::jsonb)
         RETURNING id`,
        [input.userId, input.amountMinor, input.currency],
      );
      const subscriptionId = subscription.rows[0]?.id;

      if (subscriptionId === undefined) {
        throw new Error('PostgreSQL did not return the pending subscription ID.');
      }

      const attempt = await client.query<AttemptRow>(
        `INSERT INTO subscription_payment_attempts (
           subscription_id,
           user_id,
           kind,
           status,
           idempotency_key,
           return_url
         )
         VALUES ($1, $2, 'initial', 'creating', $3, $4)
         RETURNING
           id,
           subscription_id,
           user_id,
           provider_payment_id,
           kind,
           status,
           idempotency_key,
           renews_expires_at,
           return_url,
           confirmation_url`,
        [subscriptionId, input.userId, input.idempotencyKey, input.returnUrl],
      );
      const row = attempt.rows[0];

      if (row === undefined) {
        throw new Error('PostgreSQL did not return the initial payment attempt.');
      }

      await client.query('COMMIT');
      return { kind: 'claimed', attempt: mapAttempt(row) };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async attachProviderPayment(
    input: AttachProviderPaymentInput,
  ): Promise<AttachProviderPaymentResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const attempt = await client.query<{
        readonly subscription_id: string;
        readonly kind: PaymentAttemptKind;
        readonly provider_payment_id: string | null;
        readonly status: PaymentAttemptStatus;
      }>(
        `SELECT subscription_id, kind, provider_payment_id, status
         FROM subscription_payment_attempts
         WHERE id = $1
           AND user_id = $2
         FOR UPDATE`,
        [input.attemptId, input.userId],
      );
      const row = attempt.rows[0];

      if (row === undefined) {
        await client.query('COMMIT');
        return { kind: 'stale' };
      }

      if (row.provider_payment_id !== null && row.provider_payment_id !== input.providerPaymentId) {
        await client.query('COMMIT');
        return { kind: 'stale' };
      }

      if (isTerminalAttemptStatus(row.status)) {
        await client.query('COMMIT');
        return { kind: 'terminal', status: row.status };
      }

      const attemptStatus: PaymentAttemptStatus =
        input.providerStatus === 'canceled' ? 'cancelled' : input.providerStatus;

      await client.query(
        `UPDATE subscription_payment_attempts
         SET provider_payment_id = $2,
             status = $3,
             confirmation_url = CASE
               WHEN $3::text = 'pending' THEN $4
               ELSE NULL
             END,
             raw_payload = $5::jsonb
         WHERE id = $1`,
        [
          input.attemptId,
          input.providerPaymentId,
          attemptStatus,
          input.confirmationUrl,
          JSON.stringify(input.rawPayload),
        ],
      );
      await client.query(
        `UPDATE subscriptions
         SET provider_subscription_id = COALESCE(provider_subscription_id, $2),
             raw_payload = $3::jsonb,
             status = CASE
               WHEN $4::text = 'canceled' AND $5::text = 'initial' THEN 'cancelled'
               ELSE status
             END,
             auto_renew = CASE
               WHEN $4::text = 'canceled' AND $5::text = 'initial' THEN false
               WHEN $4::text = 'canceled' AND $5::text = 'renewal' THEN false
               ELSE auto_renew
             END
         WHERE id = $1`,
        [
          row.subscription_id,
          input.providerPaymentId,
          JSON.stringify(input.rawPayload),
          input.providerStatus,
          row.kind,
        ],
      );
      await client.query('COMMIT');
      return { kind: 'attached' };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async markAttemptFailed(
    attemptId: string,
    rawPayload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const attempt = await client.query<{
        readonly subscription_id: string;
        readonly kind: PaymentAttemptKind;
      }>(
        `UPDATE subscription_payment_attempts
         SET status = 'failed',
             raw_payload = $2::jsonb
         WHERE id = $1
           AND status = 'creating'
         RETURNING subscription_id, kind`,
        [attemptId, JSON.stringify(rawPayload)],
      );
      const row = attempt.rows[0];

      if (row?.kind === 'initial') {
        await client.query(
          `UPDATE subscriptions
           SET status = 'cancelled',
               auto_renew = false
           WHERE id = $1
             AND status = 'pending'`,
          [row.subscription_id],
        );
      } else if (row?.kind === 'renewal') {
        await client.query(
          `UPDATE subscriptions
           SET auto_renew = false
           WHERE id = $1`,
          [row.subscription_id],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async applyVerifiedEvent(
    event: VerifiedPaymentEvent,
    now: Date,
  ): Promise<ApplyPaymentEventResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const insertedEvent = await client.query(
        `INSERT INTO payment_events (
           event_type,
           event_id,
           payment_id,
           user_id,
           status,
           raw_payload,
           processed_at
         )
         VALUES (
           $1,
           $2,
           $3,
           (SELECT id FROM users WHERE id = $4),
           'processed',
           $5::jsonb,
           $6
         )
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [
          event.eventType,
          event.eventId,
          event.paymentId,
          event.userId,
          JSON.stringify(event.rawPayload),
          now,
        ],
      );

      if (insertedEvent.rowCount !== 1) {
        await client.query('COMMIT');
        return 'duplicate';
      }

      const attempt = await client.query<EventAttemptRow>(
        `SELECT
           attempt.id AS attempt_id,
           attempt.kind AS attempt_kind,
           attempt.status AS attempt_status,
           attempt.provider_payment_id,
           subscription.id AS subscription_id,
           subscription.status AS subscription_status,
           subscription.expires_at
         FROM subscription_payment_attempts AS attempt
         INNER JOIN subscriptions AS subscription
           ON subscription.id = attempt.subscription_id
         WHERE attempt.id = $1
           AND attempt.subscription_id = $2
           AND attempt.user_id = $3
           AND subscription.user_id = $3
           AND (
             attempt.provider_payment_id IS NULL
             OR attempt.provider_payment_id = $4
           )
         FOR UPDATE OF attempt, subscription`,
        [event.attemptId, event.subscriptionId, event.userId, event.paymentId],
      );
      const row = attempt.rows[0];

      if (row === undefined) {
        await client.query(
          `UPDATE payment_events
           SET status = 'ignored'
           WHERE event_id = $1`,
          [event.eventId],
        );
        await client.query('COMMIT');
        return 'ignored';
      }

      if (row.provider_payment_id === null) {
        await client.query(
          `UPDATE subscription_payment_attempts
           SET provider_payment_id = $2
           WHERE id = $1`,
          [row.attempt_id, event.paymentId],
        );
      }

      if (event.outcome === 'ignored') {
        await client.query(
          `UPDATE payment_events
           SET status = 'ignored'
           WHERE event_id = $1`,
          [event.eventId],
        );
        await client.query('COMMIT');
        return 'ignored';
      }

      if (event.outcome === 'succeeded') {
        await client.query(
          `UPDATE subscription_payment_attempts
           SET status = 'succeeded',
               raw_payload = $2::jsonb
           WHERE id = $1`,
          [row.attempt_id, JSON.stringify(event.rawPayload)],
        );

        if (row.attempt_kind === 'initial') {
          const canAutoRenew = event.paymentMethodSaved && event.paymentMethodId !== null;
          await client.query(
            `UPDATE subscriptions
             SET provider_subscription_id = COALESCE(provider_subscription_id, $2),
                 status = 'active',
                 starts_at = $3::timestamptz,
                 expires_at = $3::timestamptz + INTERVAL '30 days',
                 payment_method_id = CASE
                   WHEN $5::boolean THEN $4
                   ELSE NULL
                 END,
                 auto_renew = auto_renew AND $5,
                 raw_payload = $6::jsonb
             WHERE id = $1`,
            [
              row.subscription_id,
              event.paymentId,
              now,
              event.paymentMethodId,
              canAutoRenew,
              JSON.stringify(event.rawPayload),
            ],
          );
        } else {
          await client.query(
            `UPDATE subscriptions
             SET status = 'active',
                 starts_at = COALESCE(starts_at, $2),
                 expires_at = GREATEST(COALESCE(expires_at, $2), $2) + INTERVAL '30 days',
                 payment_method_id = CASE
                   WHEN $4::boolean THEN COALESCE($3, payment_method_id)
                   ELSE payment_method_id
                 END,
                 raw_payload = $5::jsonb
             WHERE id = $1`,
            [
              row.subscription_id,
              now,
              event.paymentMethodId,
              event.paymentMethodSaved,
              JSON.stringify(event.rawPayload),
            ],
          );
        }
      } else if (event.outcome === 'cancelled') {
        await client.query(
          `UPDATE subscription_payment_attempts
           SET status = 'cancelled',
               raw_payload = $2::jsonb
           WHERE id = $1`,
          [row.attempt_id, JSON.stringify(event.rawPayload)],
        );

        if (row.attempt_kind === 'initial') {
          await client.query(
            `UPDATE subscriptions
             SET status = 'cancelled',
                 auto_renew = false,
                 raw_payload = $2::jsonb
             WHERE id = $1
               AND status = 'pending'`,
            [row.subscription_id, JSON.stringify(event.rawPayload)],
          );
        } else {
          await client.query(
            `UPDATE subscriptions
             SET status = CASE
                   WHEN expires_at IS NOT NULL AND expires_at <= $2 THEN 'expired'
                   ELSE status
                 END,
                 auto_renew = false,
                 raw_payload = $3::jsonb
             WHERE id = $1`,
            [row.subscription_id, now, JSON.stringify(event.rawPayload)],
          );
        }
      } else {
        await client.query(
          `UPDATE subscription_payment_attempts
           SET status = 'refunded',
               raw_payload = $2::jsonb
           WHERE id = $1`,
          [row.attempt_id, JSON.stringify(event.rawPayload)],
        );
        await client.query(
          `UPDATE subscriptions
           SET status = 'refunded',
               auto_renew = false,
               raw_payload = $2::jsonb
           WHERE id = $1`,
          [row.subscription_id, JSON.stringify(event.rawPayload)],
        );
      }

      await client.query('COMMIT');
      return 'applied';
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async cancelAutoRenew(userId: string, now: Date): Promise<SubscriptionLookup> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

      if (user.rowCount !== 1) {
        await client.query('COMMIT');
        return { userExists: false, subscription: null };
      }

      const selected = await client.query<SubscriptionRow>(
        `SELECT
           id,
           user_id,
           provider,
           status,
           starts_at,
           expires_at,
           amount_minor,
           currency,
           auto_renew,
           payment_method_id
         FROM subscriptions
         WHERE user_id = $1
         ORDER BY
           (
             status = 'active'
             AND (starts_at IS NULL OR starts_at <= $2)
             AND (expires_at IS NULL OR expires_at > $2)
           ) DESC,
           created_at DESC,
           id DESC
         LIMIT 1
         FOR UPDATE`,
        [userId, now],
      );
      const row = selected.rows[0];

      if (row === undefined) {
        await client.query('COMMIT');
        return { userExists: true, subscription: null };
      }

      const updated = await client.query<SubscriptionRow>(
        `UPDATE subscriptions
         SET auto_renew = false
         WHERE id = $1
         RETURNING
           id,
           user_id,
           provider,
           status,
           starts_at,
           expires_at,
           amount_minor,
           currency,
           auto_renew,
           payment_method_id`,
        [row.id],
      );
      const updatedRow = updated.rows[0];

      if (updatedRow === undefined) {
        throw new Error('PostgreSQL did not return the cancelled auto-renew subscription.');
      }

      await client.query('COMMIT');
      return { userExists: true, subscription: mapSubscription(updatedRow) };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimDueRenewals(
    now: Date,
    cutoff: Date,
    limit: number,
  ): Promise<readonly RenewalClaim[]> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const retryable = await client.query<RenewalRow>(
        `SELECT
           attempt.id,
           attempt.subscription_id,
           attempt.user_id,
           attempt.provider_payment_id,
           attempt.kind,
           attempt.status,
           attempt.idempotency_key,
           attempt.renews_expires_at,
           attempt.return_url,
           attempt.confirmation_url,
           subscription.payment_method_id
         FROM subscription_payment_attempts AS attempt
         INNER JOIN subscriptions AS subscription
           ON subscription.id = attempt.subscription_id
         WHERE attempt.kind = 'renewal'
           AND attempt.status = 'creating'
           AND subscription.status = 'active'
           AND subscription.auto_renew = true
           AND subscription.payment_method_id IS NOT NULL
           AND subscription.expires_at = attempt.renews_expires_at
           AND subscription.expires_at > $1
           AND subscription.expires_at <= $2
         ORDER BY attempt.renews_expires_at, attempt.id
         LIMIT $3
         FOR UPDATE OF attempt SKIP LOCKED`,
        [now, cutoff, limit],
      );
      const remaining = Math.max(0, limit - retryable.rows.length);
      const inserted =
        remaining === 0
          ? { rows: [] as RenewalRow[] }
          : await client.query<RenewalRow>(
              `WITH due AS MATERIALIZED (
           SELECT
             subscription.id,
             subscription.user_id,
             subscription.expires_at,
             subscription.payment_method_id
           FROM subscriptions AS subscription
           WHERE subscription.status = 'active'
             AND subscription.auto_renew = true
             AND subscription.payment_method_id IS NOT NULL
             AND subscription.expires_at IS NOT NULL
             AND subscription.expires_at > $1
             AND subscription.expires_at <= $2
             AND NOT EXISTS (
               SELECT 1
               FROM subscription_payment_attempts AS attempt
               WHERE attempt.subscription_id = subscription.id
                 AND attempt.kind = 'renewal'
                 AND attempt.renews_expires_at = subscription.expires_at
                 AND attempt.status IN ('creating', 'pending', 'succeeded')
             )
           ORDER BY subscription.expires_at, subscription.id
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         ), inserted AS (
           INSERT INTO subscription_payment_attempts (
             subscription_id,
             user_id,
             kind,
             status,
             idempotency_key,
             renews_expires_at
           )
           SELECT
             due.id,
             due.user_id,
             'renewal',
             'creating',
             gen_random_uuid(),
             due.expires_at
           FROM due
           ON CONFLICT DO NOTHING
           RETURNING
             id,
             subscription_id,
             user_id,
             provider_payment_id,
             kind,
             status,
             idempotency_key,
             renews_expires_at,
             return_url,
             confirmation_url
         )
         SELECT inserted.*, subscription.payment_method_id
         FROM inserted
         INNER JOIN subscriptions AS subscription
           ON subscription.id = inserted.subscription_id
         ORDER BY inserted.renews_expires_at, inserted.id`,
              [now, cutoff, remaining],
            );
      await client.query('COMMIT');

      return [...retryable.rows, ...inserted.rows].map((row) => ({
        ...mapAttempt(row),
        paymentMethodId: row.payment_method_id,
      }));
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async executeRenewalClaim(
    claim: RenewalClaim,
    now: Date,
    createPayment: (validatedClaim: RenewalClaim) => Promise<RenewalProviderPayment>,
  ): Promise<RenewalClaimExecutionResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const selected = await client.query<RenewalRow>(
        `SELECT
           attempt.id,
           attempt.subscription_id,
           attempt.user_id,
           attempt.provider_payment_id,
           attempt.kind,
           attempt.status,
           attempt.idempotency_key,
           attempt.renews_expires_at,
           attempt.return_url,
           attempt.confirmation_url,
           subscription.payment_method_id
         FROM subscription_payment_attempts AS attempt
         INNER JOIN subscriptions AS subscription
           ON subscription.id = attempt.subscription_id
         WHERE attempt.id = $1
           AND attempt.subscription_id = $2
           AND attempt.user_id = $3
           AND attempt.idempotency_key = $4
           AND attempt.kind = 'renewal'
           AND attempt.status = 'creating'
           AND attempt.provider_payment_id IS NULL
           AND subscription.status = 'active'
           AND subscription.auto_renew = true
           AND subscription.payment_method_id IS NOT NULL
           AND subscription.expires_at = attempt.renews_expires_at
           AND subscription.expires_at > $5
         FOR UPDATE OF attempt, subscription`,
        [claim.id, claim.subscriptionId, claim.userId, claim.idempotencyKey, now],
      );
      const row = selected.rows[0];

      if (row === undefined) {
        await client.query('COMMIT');
        return { kind: 'skipped' };
      }

      const validatedClaim: RenewalClaim = {
        ...mapAttempt(row),
        paymentMethodId: row.payment_method_id,
      };
      const payment = await createPayment(validatedClaim);
      const attemptStatus: PaymentAttemptStatus =
        payment.providerStatus === 'canceled' ? 'cancelled' : payment.providerStatus;

      await client.query(
        `UPDATE subscription_payment_attempts
         SET provider_payment_id = $2,
             status = $3,
             raw_payload = $4::jsonb
         WHERE id = $1`,
        [
          validatedClaim.id,
          payment.providerPaymentId,
          attemptStatus,
          JSON.stringify(payment.rawPayload),
        ],
      );
      await client.query(
        `UPDATE subscriptions
         SET auto_renew = CASE
               WHEN $2::text = 'canceled' THEN false
               ELSE auto_renew
             END,
             raw_payload = $3::jsonb
         WHERE id = $1`,
        [validatedClaim.subscriptionId, payment.providerStatus, JSON.stringify(payment.rawPayload)],
      );
      await client.query('COMMIT');
      return { kind: 'created', providerStatus: payment.providerStatus };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async expireElapsedSubscriptions(now: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE subscriptions
       SET status = 'expired'
       WHERE status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= $1`,
      [now],
    );

    return result.rowCount ?? 0;
  }
}
