import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresPaymentsRepository } from '../src/payments/postgres-payments.repository.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

test(
  'PostgreSQL payments repository applies events once and durably reuses renewal claims',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PostgresPaymentsRepository(pool);
    const userId = randomUUID();
    const now = new Date('2026-08-21T12:00:00.000Z');
    const initialPaymentId = `t11-initial-${randomUUID()}`;
    const initialEventId = `yukassa:payment.succeeded:${initialPaymentId}`;
    const lateEventId = `yukassa:payment.canceled:${initialPaymentId}`;
    let renewalEventId: string | null = null;

    try {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, onboarding_status)
         VALUES ($1, $2, $3, 'active')`,
        [
          userId,
          `payments-${userId}@example.com`,
          '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
        ],
      );
      const claimed = await repository.claimInitialPayment({
        userId,
        returnUrl: 'https://app.kinetra.test/payment/success',
        idempotencyKey: randomUUID(),
        amountMinor: 79_900,
        currency: 'RUB',
        now,
      });
      assert.equal(claimed.kind, 'claimed');

      if (claimed.kind !== 'claimed') {
        throw new Error('Expected an initial payment claim.');
      }

      assert.deepEqual(
        await repository.attachProviderPayment({
          attemptId: claimed.attempt.id,
          userId,
          providerPaymentId: initialPaymentId,
          providerStatus: 'pending',
          confirmationUrl: 'https://yookassa.test/checkout/initial',
          rawPayload: { id: initialPaymentId, status: 'pending' },
        }),
        { kind: 'attached' },
      );
      const initialEvent = {
        eventId: initialEventId,
        eventType: 'payment.succeeded',
        providerObjectId: initialPaymentId,
        paymentId: initialPaymentId,
        userId,
        subscriptionId: claimed.attempt.subscriptionId,
        attemptId: claimed.attempt.id,
        outcome: 'succeeded',
        paymentMethodId: 'saved-method-postgres',
        paymentMethodSaved: true,
        rawPayload: { type: 'notification', event: 'payment.succeeded' },
      } as const;
      const concurrent = await Promise.all([
        repository.applyVerifiedEvent(initialEvent, now),
        repository.applyVerifiedEvent(initialEvent, now),
      ]);
      assert.deepEqual([...concurrent].sort(), ['applied', 'duplicate']);

      const persisted = await pool.query<{
        readonly status: string;
        readonly starts_at: Date;
        readonly expires_at: Date;
        readonly auto_renew: boolean;
        readonly payment_method_id: string | null;
      }>(
        `SELECT status, starts_at, expires_at, auto_renew, payment_method_id
         FROM subscriptions
         WHERE id = $1`,
        [claimed.attempt.subscriptionId],
      );
      assert.equal(persisted.rows[0]?.status, 'active');
      assert.equal(persisted.rows[0]?.starts_at.toISOString(), now.toISOString());
      assert.equal(persisted.rows[0]?.expires_at.toISOString(), '2026-09-20T12:00:00.000Z');
      assert.equal(persisted.rows[0]?.auto_renew, true);
      assert.equal(persisted.rows[0]?.payment_method_id, 'saved-method-postgres');
      const eventCount = await pool.query<{ readonly count: string }>(
        'SELECT COUNT(*)::text AS count FROM payment_events WHERE event_id = $1',
        [initialEventId],
      );
      assert.equal(eventCount.rows[0]?.count, '1');

      const cancelled = await repository.cancelAutoRenew(userId, now);
      assert.equal(cancelled.subscription?.status, 'active');
      assert.equal(cancelled.subscription?.autoRenew, false);
      assert.equal(cancelled.subscription?.expiresAt?.toISOString(), '2026-09-20T12:00:00.000Z');

      const renewalTarget = new Date('2026-08-22T00:00:00.000Z');
      await pool.query(
        `UPDATE subscriptions
         SET status = 'active',
             expires_at = $2,
             auto_renew = true,
             payment_method_id = 'saved-method-postgres'
         WHERE id = $1`,
        [claimed.attempt.subscriptionId, renewalTarget],
      );
      const firstRenewalClaims = await repository.claimDueRenewals(
        now,
        new Date('2026-08-22T12:00:00.000Z'),
        10,
      );
      assert.equal(firstRenewalClaims.length, 1);
      const retryClaims = await repository.claimDueRenewals(
        now,
        new Date('2026-08-22T12:00:00.000Z'),
        10,
      );
      assert.equal(retryClaims.length, 1);
      assert.equal(retryClaims[0]?.id, firstRenewalClaims[0]?.id);
      assert.equal(retryClaims[0]?.idempotencyKey, firstRenewalClaims[0]?.idempotencyKey);

      const renewal = firstRenewalClaims[0];

      if (renewal === undefined) {
        throw new Error('Expected a renewal claim.');
      }

      const renewalPaymentId = `t11-renewal-${randomUUID()}`;
      let signalProviderStarted = (): void => undefined;
      const providerStarted = new Promise<void>((resolve) => {
        signalProviderStarted = resolve;
      });
      let releaseProvider = (): void => undefined;
      const providerGate = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      const execution = repository.executeRenewalClaim(renewal, now, async (validatedClaim) => {
        assert.equal(validatedClaim.id, renewal.id);
        assert.equal(validatedClaim.idempotencyKey, renewal.idempotencyKey);
        signalProviderStarted();
        await providerGate;
        return {
          providerPaymentId: renewalPaymentId,
          providerStatus: 'pending',
          rawPayload: { id: renewalPaymentId, status: 'pending' },
        };
      });
      await providerStarted;
      let cancellationSettled = false;
      const concurrentCancellation = repository.cancelAutoRenew(userId, now).then((result) => {
        cancellationSettled = true;
        return result;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      assert.equal(cancellationSettled, false);
      releaseProvider();
      const [executionResult, serializedCancellation] = await Promise.all([
        execution,
        concurrentCancellation,
      ]);
      assert.deepEqual(executionResult, { kind: 'created', providerStatus: 'pending' });
      assert.equal(serializedCancellation.subscription?.autoRenew, false);
      assert.equal(
        (await repository.claimDueRenewals(now, new Date('2026-08-22T12:00:00.000Z'), 10)).length,
        0,
      );
      renewalEventId = `yukassa:payment.succeeded:${renewalPaymentId}`;
      const renewalEvent = {
        eventId: renewalEventId,
        eventType: 'payment.succeeded',
        providerObjectId: renewalPaymentId,
        paymentId: renewalPaymentId,
        userId,
        subscriptionId: renewal.subscriptionId,
        attemptId: renewal.id,
        outcome: 'succeeded',
        paymentMethodId: 'saved-method-postgres',
        paymentMethodSaved: true,
        rawPayload: { type: 'notification', event: 'payment.succeeded' },
      } as const;
      assert.equal(await repository.applyVerifiedEvent(renewalEvent, now), 'applied');
      assert.equal(await repository.applyVerifiedEvent(renewalEvent, now), 'duplicate');
      const renewed = await pool.query<{ readonly expires_at: Date }>(
        'SELECT expires_at FROM subscriptions WHERE id = $1',
        [renewal.subscriptionId],
      );
      assert.equal(renewed.rows[0]?.expires_at.toISOString(), '2026-09-21T00:00:00.000Z');
      console.log('KINETRA_T11_RENEWAL_IDEMPOTENCY=PASS');

      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      const retainedAudit = await pool.query<{ readonly user_id: string | null }>(
        'SELECT user_id FROM payment_events WHERE event_id = $1',
        [initialEventId],
      );
      assert.equal(retainedAudit.rows[0]?.user_id, null);
      assert.equal(
        await repository.applyVerifiedEvent(
          {
            ...initialEvent,
            eventId: lateEventId,
            eventType: 'payment.canceled',
            outcome: 'cancelled',
          },
          now,
        ),
        'ignored',
      );
      const lateAudit = await pool.query<{
        readonly user_id: string | null;
        readonly status: string;
      }>('SELECT user_id, status FROM payment_events WHERE event_id = $1', [lateEventId]);
      assert.deepEqual(lateAudit.rows[0], { user_id: null, status: 'ignored' });
      console.log('KINETRA_T11_POSTGRES_INTEGRATION=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      await pool.query('DELETE FROM payment_events WHERE event_id = ANY($1::text[])', [
        [initialEventId, lateEventId, ...(renewalEventId === null ? [] : [renewalEventId])],
      ]);
      await pool.end();
    }
  },
);

test(
  'PostgreSQL provider attachment preserves terminal events and rejects unsaved methods',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const repository = new PostgresPaymentsRepository(pool);
    const now = new Date('2026-08-21T12:00:00.000Z');
    const userIds: string[] = [];
    const eventIds: string[] = [];

    try {
      for (const terminalCase of [
        {
          outcome: 'cancelled',
          eventType: 'payment.canceled',
          expectedAttemptStatus: 'cancelled',
          expectedSubscriptionStatus: 'cancelled',
          expectedAutoRenew: false,
        },
        {
          outcome: 'succeeded',
          eventType: 'payment.succeeded',
          expectedAttemptStatus: 'succeeded',
          expectedSubscriptionStatus: 'active',
          expectedAutoRenew: true,
        },
      ] as const) {
        const userId = randomUUID();
        userIds.push(userId);
        await pool.query(
          `INSERT INTO users (id, email, password_hash, onboarding_status)
           VALUES ($1, $2, $3, 'active')`,
          [
            userId,
            `payments-attach-${userId}@example.com`,
            '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
          ],
        );
        const claim = await repository.claimInitialPayment({
          userId,
          returnUrl: 'https://app.kinetra.test/payment/success',
          idempotencyKey: randomUUID(),
          amountMinor: 79_900,
          currency: 'RUB',
          now,
        });

        if (claim.kind !== 'claimed') {
          throw new Error('Expected an initial payment claim for the attachment race test.');
        }

        const paymentId = `t11-attach-${randomUUID()}`;
        const eventId = `yukassa:${terminalCase.eventType}:${paymentId}`;
        eventIds.push(eventId);
        assert.equal(
          await repository.applyVerifiedEvent(
            {
              eventId,
              eventType: terminalCase.eventType,
              providerObjectId: paymentId,
              paymentId,
              userId,
              subscriptionId: claim.attempt.subscriptionId,
              attemptId: claim.attempt.id,
              outcome: terminalCase.outcome,
              paymentMethodId: terminalCase.outcome === 'succeeded' ? `saved-${paymentId}` : null,
              paymentMethodSaved: terminalCase.outcome === 'succeeded',
              rawPayload: { event: terminalCase.eventType },
            },
            now,
          ),
          'applied',
        );
        assert.deepEqual(
          await repository.attachProviderPayment({
            attemptId: claim.attempt.id,
            userId,
            providerPaymentId: paymentId,
            providerStatus: 'pending',
            confirmationUrl: `https://yookassa.test/stale/${paymentId}`,
            rawPayload: { id: paymentId, status: 'pending' },
          }),
          { kind: 'terminal', status: terminalCase.expectedAttemptStatus },
        );
        const persisted = await pool.query<{
          readonly attempt_status: string;
          readonly confirmation_url: string | null;
          readonly subscription_status: string;
          readonly auto_renew: boolean;
        }>(
          `SELECT
             attempt.status AS attempt_status,
             attempt.confirmation_url,
             subscription.status AS subscription_status,
             subscription.auto_renew
           FROM subscription_payment_attempts AS attempt
           INNER JOIN subscriptions AS subscription ON subscription.id = attempt.subscription_id
           WHERE attempt.id = $1`,
          [claim.attempt.id],
        );
        assert.deepEqual(persisted.rows[0], {
          attempt_status: terminalCase.expectedAttemptStatus,
          confirmation_url: null,
          subscription_status: terminalCase.expectedSubscriptionStatus,
          auto_renew: terminalCase.expectedAutoRenew,
        });
      }

      const unsavedUserId = randomUUID();
      userIds.push(unsavedUserId);
      await pool.query(
        `INSERT INTO users (id, email, password_hash, onboarding_status)
         VALUES ($1, $2, $3, 'active')`,
        [
          unsavedUserId,
          `payments-unsaved-${unsavedUserId}@example.com`,
          '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
        ],
      );
      const unsavedClaim = await repository.claimInitialPayment({
        userId: unsavedUserId,
        returnUrl: 'https://app.kinetra.test/payment/success',
        idempotencyKey: randomUUID(),
        amountMinor: 79_900,
        currency: 'RUB',
        now,
      });

      if (unsavedClaim.kind !== 'claimed') {
        throw new Error('Expected an initial payment claim for the unsaved method test.');
      }

      const unsavedPaymentId = `t11-unsaved-${randomUUID()}`;
      const unsavedEventId = `yukassa:payment.succeeded:${unsavedPaymentId}`;
      eventIds.push(unsavedEventId);
      assert.equal(
        await repository.applyVerifiedEvent(
          {
            eventId: unsavedEventId,
            eventType: 'payment.succeeded',
            providerObjectId: unsavedPaymentId,
            paymentId: unsavedPaymentId,
            userId: unsavedUserId,
            subscriptionId: unsavedClaim.attempt.subscriptionId,
            attemptId: unsavedClaim.attempt.id,
            outcome: 'succeeded',
            paymentMethodId: `must-not-persist-${unsavedPaymentId}`,
            paymentMethodSaved: false,
            rawPayload: { event: 'payment.succeeded' },
          },
          now,
        ),
        'applied',
      );
      const unsavedSubscription = await pool.query<{
        readonly payment_method_id: string | null;
        readonly auto_renew: boolean;
      }>(
        `SELECT payment_method_id, auto_renew
         FROM subscriptions
         WHERE id = $1`,
        [unsavedClaim.attempt.subscriptionId],
      );
      assert.deepEqual(unsavedSubscription.rows[0], {
        payment_method_id: null,
        auto_renew: false,
      });
      console.log('KINETRA_T11_ATTACH_MONOTONICITY=PASS');
    } finally {
      await pool.query('DELETE FROM payment_events WHERE event_id = ANY($1::text[])', [eventIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
      await pool.end();
    }
  },
);
