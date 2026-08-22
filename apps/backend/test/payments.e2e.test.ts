import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import { RenewalService } from '../src/payments/renewal-service.js';
import type { PaymentSubscriptionSnapshot } from '../src/payments/repository.js';
import type { PaymentsRuntime } from '../src/payments/runtime.js';
import type { YooKassaPayment } from '../src/payments/schema.js';
import { PaymentsService } from '../src/payments/service.js';
import { YooKassaWebhookSourceVerifier } from '../src/payments/webhook-source.js';
import { YooKassaApiError } from '../src/payments/yookassa-client.js';
import {
  FakeRenewalFailureNotifier,
  FakeYooKassaClient,
  FixedWebhookSourceVerifier,
} from './support/fake-yookassa-client.js';
import { InMemoryPaymentsRepository } from './support/in-memory-payments.repository.js';
import { MutableClock } from './support/test-clock.js';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly cacheControl: string | null;
}

interface TestHarness {
  readonly baseUrl: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly repository: InMemoryPaymentsRepository;
  readonly client: FakeYooKassaClient;
  readonly sourceVerifier: FixedWebhookSourceVerifier;
  readonly notifier: FakeRenewalFailureNotifier;
  readonly renewalService: RenewalService;
  readonly service: PaymentsService;
  readonly clock: MutableClock;
  close(): Promise<void>;
}

const RETURN_URL = 'https://app.kinetra.test/payment/success';

const asObject = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
};

const errorCode = (body: unknown): string => {
  const error = asObject(asObject(body).error);
  assert.equal(typeof error.code, 'string');
  return error.code as string;
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

const startHarness = async (): Promise<TestHarness> => {
  const userId = randomUUID();
  const clock = new MutableClock(new Date('2026-08-21T12:00:00.000Z'));
  const accessTokens = new HmacJwtAccessTokenService(
    'test-only-payments-access-secret-with-more-than-32-characters',
    'kinetra-payments-test',
    'kinetra-payments-pwa-test',
    900,
  );
  const repository = new InMemoryPaymentsRepository(userId);
  const client = new FakeYooKassaClient();
  const sourceVerifier = new FixedWebhookSourceVerifier(true);
  const notifier = new FakeRenewalFailureNotifier();
  const renewalService = new RenewalService(repository, client, clock, notifier);
  const service = new PaymentsService(repository, client, clock, [RETURN_URL]);
  const paymentsRuntime: PaymentsRuntime = {
    service,
    renewalService,
    authMiddleware: createAuthMiddleware(accessTokens),
    webhookSourceVerifier: sourceVerifier,
  };
  const server = createServer(createApp({ paymentsRuntime }));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    userId,
    accessToken: (await accessTokens.issue(userId, randomUUID(), new Date())).token,
    repository,
    client,
    sourceVerifier,
    notifier,
    renewalService,
    service,
    clock,
    close: () => closeServer(server),
  };
};

const requestJson = async (
  harness: TestHarness,
  path: string,
  options: {
    readonly body?: unknown;
    readonly token?: string | null;
  } = {},
): Promise<ApiResult> => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (options.token !== null && path !== '/api/v1/payments/webhook') {
    headers.authorization = `Bearer ${options.token ?? harness.accessToken}`;
  }

  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
  const text = await response.text();

  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
    cacheControl: response.headers.get('cache-control'),
  };
};

const createInitialPayment = async (harness: TestHarness): Promise<Record<string, unknown>> => {
  const response = await requestJson(harness, '/api/v1/payments/create', {
    body: { return_url: RETURN_URL },
  });
  assert.equal(response.status, 201);
  return asObject(response.body);
};

const succeededPaymentFor = (harness: TestHarness, paymentId: string): YooKassaPayment => {
  const metadata = harness.client.created[0]?.input.metadata;

  if (metadata === undefined) {
    throw new Error('The fake client did not capture payment metadata.');
  }

  return {
    id: paymentId,
    status: 'succeeded',
    paid: true,
    amount: { value: '799.00', currency: 'RUB' },
    metadata,
    payment_method: { id: `method-${paymentId}`, saved: true },
  };
};

test('official YooKassa CIDR verifier accepts documented sources and fails closed', () => {
  const verifier = new YooKassaWebhookSourceVerifier();
  assert.equal(verifier.isAllowed('185.71.76.1'), true);
  assert.equal(verifier.isAllowed('::ffff:77.75.156.11'), true);
  assert.equal(verifier.isAllowed('2a02:5180::1'), true);
  assert.equal(verifier.isAllowed('127.0.0.1'), false);
  assert.equal(verifier.isAllowed(undefined), false);
});

test('an incomplete active period does not block a fresh initial payment claim', async () => {
  const now = new Date('2026-08-21T12:00:00.000Z');

  for (const incompletePeriod of [
    { startsAt: null, expiresAt: new Date('2026-09-01T00:00:00.000Z') },
    { startsAt: new Date('2026-08-01T00:00:00.000Z'), expiresAt: null },
  ] as const) {
    const userId = randomUUID();
    const repository = new InMemoryPaymentsRepository(userId);
    repository.seedSubscription({
      id: randomUUID(),
      userId,
      provider: 'yukassa',
      status: 'active',
      startsAt: incompletePeriod.startsAt,
      expiresAt: incompletePeriod.expiresAt,
      amountMinor: 79_900,
      currency: 'RUB',
      autoRenew: false,
      paymentMethodId: null,
    });

    const claim = await repository.claimInitialPayment({
      userId,
      returnUrl: RETURN_URL,
      idempotencyKey: randomUUID(),
      amountMinor: 79_900,
      currency: 'RUB',
      now,
    });
    assert.equal(claim.kind, 'claimed');
  }
});

test('payment create and cancellation are protected while webhook is public and IP-guarded', async () => {
  const harness = await startHarness();

  try {
    for (const path of ['/api/v1/payments/create', '/api/v1/payments/cancel-subscription']) {
      const unauthorized = await requestJson(harness, path, {
        body: path.endsWith('/create') ? { return_url: RETURN_URL } : {},
        token: null,
      });
      assert.equal(unauthorized.status, 401);
      assert.equal(errorCode(unauthorized.body), 'AUTHENTICATION_REQUIRED');
      assert.equal(unauthorized.cacheControl, 'no-store');
    }

    harness.sourceVerifier.setAllowed(false);
    const forbidden = await requestJson(harness, '/api/v1/payments/webhook', {
      body: {},
    });
    assert.equal(forbidden.status, 403);
    assert.equal(errorCode(forbidden.body), 'PAYMENT_WEBHOOK_SOURCE_FORBIDDEN');
    harness.sourceVerifier.setAllowed(true);

    const invalid = await requestJson(harness, '/api/v1/payments/webhook', {
      body: { event: 'payment.succeeded' },
    });
    assert.equal(invalid.status, 400);
    assert.equal(errorCode(invalid.body), 'INVALID_PAYMENT_WEBHOOK');
    console.log('KINETRA_T11_WEBHOOK_AUTH=PASS');
  } finally {
    await harness.close();
  }
});

test('payment creation sends the exact subscription request and reuses an open attempt', async () => {
  const harness = await startHarness();

  try {
    const body = await createInitialPayment(harness);
    assert.equal(body.status, 'pending');
    assert.equal(typeof body.payment_id, 'string');
    assert.match(String(body.confirmation_url), /^https:\/\/yookassa\.test\/checkout\//u);
    assert.equal(harness.client.created.length, 1);
    const captured = harness.client.created[0];
    assert.equal(captured?.input.amount.value, '799.00');
    assert.equal(captured?.input.amount.currency, 'RUB');
    assert.equal(captured?.input.capture, true);
    assert.equal(captured?.input.save_payment_method, true);
    assert.equal(captured?.input.confirmation?.return_url, RETURN_URL);
    assert.equal(captured?.input.metadata.user_id, harness.userId);
    assert.match(captured?.idempotencyKey ?? '', /^[0-9a-f-]{36}$/u);

    const repeated = await createInitialPayment(harness);
    assert.deepEqual(repeated, body);
    assert.equal(harness.client.created.length, 1);

    const rejectedReturn = await requestJson(harness, '/api/v1/payments/create', {
      body: { return_url: 'https://attacker.example/payment/success' },
    });
    assert.equal(rejectedReturn.status, 400);
    assert.equal(errorCode(rejectedReturn.body), 'PAYMENT_RETURN_URL_NOT_ALLOWED');
  } finally {
    await harness.close();
  }
});

test('payment creation never returns a non-HTTPS provider confirmation URL', async () => {
  const harness = await startHarness();
  harness.client.configureNextPayment((input) => ({
    id: randomUUID(),
    status: 'pending',
    paid: false,
    amount: input.amount,
    confirmation: {
      type: 'redirect',
      confirmation_url: 'http://checkout.attacker.test/payment',
    },
    metadata: input.metadata,
  }));

  try {
    const response = await requestJson(harness, '/api/v1/payments/create', {
      body: { return_url: RETURN_URL },
    });
    assert.equal(response.status, 502);
    assert.equal(errorCode(response.body), 'INVALID_PAYMENT_PROVIDER_RESPONSE');
    assert.equal(harness.repository.peekAttempts()[0]?.confirmationUrl, null);
  } finally {
    await harness.close();
  }
});

test('payment creation rejects provider responses not bound to the claimed subscription', async () => {
  for (const mismatch of ['amount', 'metadata'] as const) {
    const harness = await startHarness();
    harness.client.configureNextPayment((input, idempotencyKey) => ({
      id: randomUUID(),
      status: 'pending',
      paid: false,
      amount: mismatch === 'amount' ? { value: '1.00', currency: 'RUB' } : { ...input.amount },
      confirmation: {
        type: 'redirect',
        confirmation_url: `https://yookassa.test/checkout/${idempotencyKey}`,
      },
      metadata:
        mismatch === 'metadata'
          ? { ...input.metadata, attempt_id: randomUUID() }
          : { ...input.metadata },
    }));

    try {
      const response = await requestJson(harness, '/api/v1/payments/create', {
        body: { return_url: RETURN_URL },
      });
      assert.equal(response.status, 502);
      assert.equal(errorCode(response.body), 'INVALID_PAYMENT_PROVIDER_RESPONSE');
      assert.equal(harness.repository.peekAttempts()[0]?.status, 'creating');
    } finally {
      await harness.close();
    }
  }
});

test('a canceled webhook before provider attachment cannot regress to pending', async () => {
  const harness = await startHarness();
  let terminalPaymentId = '';
  harness.client.setAfterCreatePayment(async (pendingPayment) => {
    terminalPaymentId = pendingPayment.id;
    const canceledPayment: YooKassaPayment = {
      ...pendingPayment,
      status: 'canceled',
      paid: false,
    };
    harness.client.seedPayment(canceledPayment);
    await harness.service.handleWebhook({
      type: 'notification',
      event: 'payment.canceled',
      object: canceledPayment,
    });
  });

  try {
    const raced = await requestJson(harness, '/api/v1/payments/create', {
      body: { return_url: RETURN_URL },
    });
    assert.equal(raced.status, 409);
    assert.equal(errorCode(raced.body), 'PAYMENT_ALREADY_CANCELLED');
    const terminalAttempt = harness.repository.peekAttempts()[0];
    assert.equal(terminalAttempt?.providerPaymentId, terminalPaymentId);
    assert.equal(terminalAttempt?.status, 'cancelled');
    assert.equal(terminalAttempt?.confirmationUrl, null);
    assert.equal(harness.repository.peekSubscription()?.status, 'cancelled');
    assert.equal(harness.repository.peekSubscription()?.autoRenew, false);

    const retry = await requestJson(harness, '/api/v1/payments/create', {
      body: { return_url: RETURN_URL },
    });
    assert.equal(retry.status, 201);
    assert.notEqual(asObject(retry.body).payment_id, terminalPaymentId);
    assert.equal(harness.client.created.length, 2);
  } finally {
    await harness.close();
  }
});

test('a succeeded webhook before provider attachment cannot regress to pending', async () => {
  const harness = await startHarness();
  let terminalPaymentId = '';
  harness.client.setAfterCreatePayment(async (pendingPayment) => {
    terminalPaymentId = pendingPayment.id;
    const succeededPayment: YooKassaPayment = {
      ...pendingPayment,
      status: 'succeeded',
      paid: true,
      payment_method: { id: `method-${pendingPayment.id}`, saved: true },
    };
    harness.client.seedPayment(succeededPayment);
    await harness.service.handleWebhook({
      type: 'notification',
      event: 'payment.succeeded',
      object: succeededPayment,
    });
  });

  try {
    const raced = await requestJson(harness, '/api/v1/payments/create', {
      body: { return_url: RETURN_URL },
    });
    assert.equal(raced.status, 409);
    assert.equal(errorCode(raced.body), 'SUBSCRIPTION_ALREADY_ACTIVE');
    const terminalAttempt = harness.repository.peekAttempts()[0];
    assert.equal(terminalAttempt?.providerPaymentId, terminalPaymentId);
    assert.equal(terminalAttempt?.status, 'succeeded');
    assert.equal(terminalAttempt?.confirmationUrl, null);
    assert.equal(harness.repository.peekSubscription()?.status, 'active');

    const retry = await requestJson(harness, '/api/v1/payments/create', {
      body: { return_url: RETURN_URL },
    });
    assert.equal(retry.status, 409);
    assert.equal(errorCode(retry.body), 'SUBSCRIPTION_ALREADY_ACTIVE');
    assert.equal(harness.client.created.length, 1);
  } finally {
    await harness.close();
  }
});

test('verified succeeded webhook activates exactly once and cancel preserves paid expiry', async () => {
  const harness = await startHarness();

  try {
    const created = await createInitialPayment(harness);
    const paymentId = String(created.payment_id);
    const canonical = succeededPaymentFor(harness, paymentId);
    harness.client.seedPayment(canonical);
    const webhook = {
      type: 'notification',
      event: 'payment.succeeded',
      object: canonical,
    };
    const first = await requestJson(harness, '/api/v1/payments/webhook', { body: webhook });
    assert.equal(first.status, 200);
    const active = harness.repository.peekSubscription();
    assert.equal(active?.status, 'active');
    assert.equal(active?.autoRenew, true);
    assert.equal(active?.paymentMethodId, `method-${paymentId}`);
    const expiry = active?.expiresAt?.toISOString();
    assert.equal(expiry, '2026-09-20T12:00:00.000Z');

    const duplicate = await requestJson(harness, '/api/v1/payments/webhook', { body: webhook });
    assert.equal(duplicate.status, 200);
    assert.equal(harness.repository.eventCount(), 1);
    assert.equal(harness.repository.peekSubscription()?.expiresAt?.toISOString(), expiry);
    console.log('KINETRA_T11_WEBHOOK_IDEMPOTENCY=PASS');

    const cancelled = await requestJson(harness, '/api/v1/payments/cancel-subscription');
    assert.equal(cancelled.status, 200);
    const cancellationBody = asObject(cancelled.body);
    assert.equal(cancellationBody.status, 'active');
    assert.equal(cancellationBody.auto_renew, false);
    assert.equal(cancellationBody.expires_at, expiry);
    assert.equal(harness.repository.peekSubscription()?.status, 'active');
  } finally {
    await harness.close();
  }
});

test('an unsaved provider payment method is never persisted or enabled for renewal', async () => {
  const harness = await startHarness();

  try {
    const created = await createInitialPayment(harness);
    const paymentId = String(created.payment_id);
    const canonical: YooKassaPayment = {
      ...succeededPaymentFor(harness, paymentId),
      payment_method: { id: `unsaved-${paymentId}`, saved: false },
    };
    harness.client.seedPayment(canonical);
    const webhook = await requestJson(harness, '/api/v1/payments/webhook', {
      body: { type: 'notification', event: 'payment.succeeded', object: canonical },
    });
    assert.equal(webhook.status, 200);
    const subscription = harness.repository.peekSubscription();
    assert.equal(subscription?.status, 'active');
    assert.equal(subscription?.paymentMethodId, null);
    assert.equal(subscription?.autoRenew, false);
  } finally {
    await harness.close();
  }
});

test('canceling auto-renew while payment is pending is preserved by the success webhook', async () => {
  const harness = await startHarness();

  try {
    const created = await createInitialPayment(harness);
    const cancelled = await requestJson(harness, '/api/v1/payments/cancel-subscription');
    assert.equal(cancelled.status, 200);
    assert.equal(asObject(cancelled.body).auto_renew, false);

    const paymentId = String(created.payment_id);
    const canonical = succeededPaymentFor(harness, paymentId);
    harness.client.seedPayment(canonical);
    const webhook = await requestJson(harness, '/api/v1/payments/webhook', {
      body: { type: 'notification', event: 'payment.succeeded', object: canonical },
    });
    assert.equal(webhook.status, 200);
    assert.equal(harness.repository.peekSubscription()?.status, 'active');
    assert.equal(harness.repository.peekSubscription()?.autoRenew, false);
  } finally {
    await harness.close();
  }
});

test('canceled and full-refund webhooks use verified provider objects', async () => {
  const canceledHarness = await startHarness();

  try {
    const created = await createInitialPayment(canceledHarness);
    const paymentId = String(created.payment_id);
    const metadata = canceledHarness.client.created[0]?.input.metadata;

    if (metadata === undefined) {
      throw new Error('The fake client did not capture payment metadata.');
    }

    const canonical = {
      id: paymentId,
      status: 'canceled',
      paid: false,
      amount: { value: '799.00', currency: 'RUB' },
      metadata,
    } as const;
    canceledHarness.client.seedPayment(canonical);
    const response = await requestJson(canceledHarness, '/api/v1/payments/webhook', {
      body: { type: 'notification', event: 'payment.canceled', object: canonical },
    });
    assert.equal(response.status, 200);
    assert.equal(canceledHarness.repository.peekSubscription()?.status, 'cancelled');
  } finally {
    await canceledHarness.close();
  }

  const refundedHarness = await startHarness();

  try {
    const created = await createInitialPayment(refundedHarness);
    const paymentId = String(created.payment_id);
    const succeeded = succeededPaymentFor(refundedHarness, paymentId);
    refundedHarness.client.seedPayment(succeeded);
    await requestJson(refundedHarness, '/api/v1/payments/webhook', {
      body: { type: 'notification', event: 'payment.succeeded', object: succeeded },
    });
    const partialRefund = {
      id: randomUUID(),
      status: 'succeeded',
      payment_id: paymentId,
      amount: { value: '100.00', currency: 'RUB' },
    } as const;
    refundedHarness.client.seedRefund(partialRefund);
    const partialResponse = await requestJson(refundedHarness, '/api/v1/payments/webhook', {
      body: { type: 'notification', event: 'refund.succeeded', object: partialRefund },
    });
    assert.equal(partialResponse.status, 200);
    assert.equal(refundedHarness.repository.peekSubscription()?.status, 'active');

    const refund = {
      id: randomUUID(),
      status: 'succeeded',
      payment_id: paymentId,
      amount: { value: '799.00', currency: 'RUB' },
    } as const;
    refundedHarness.client.seedRefund(refund);
    refundedHarness.client.seedPayment({ ...succeeded, refunded_amount: refund.amount });
    const response = await requestJson(refundedHarness, '/api/v1/payments/webhook', {
      body: { type: 'notification', event: 'refund.succeeded', object: refund },
    });
    assert.equal(response.status, 200);
    assert.equal(refundedHarness.repository.peekSubscription()?.status, 'refunded');
    console.log('KINETRA_T11_BACKEND_E2E=PASS');
  } finally {
    await refundedHarness.close();
  }
});

test('a delayed payment success cannot reactivate a payment already fully refunded', async () => {
  const harness = await startHarness();

  try {
    const created = await createInitialPayment(harness);
    const paymentId = String(created.payment_id);
    const refund = {
      id: randomUUID(),
      status: 'succeeded',
      payment_id: paymentId,
      amount: { value: '799.00', currency: 'RUB' },
    } as const;
    const fullyRefundedPayment = {
      ...succeededPaymentFor(harness, paymentId),
      refunded_amount: { ...refund.amount },
    };
    harness.client.seedPayment(fullyRefundedPayment);
    harness.client.seedRefund(refund);

    const refundResponse = await requestJson(harness, '/api/v1/payments/webhook', {
      body: { type: 'notification', event: 'refund.succeeded', object: refund },
    });
    assert.equal(refundResponse.status, 200);
    assert.equal(harness.repository.peekSubscription()?.status, 'refunded');

    const delayedSuccess = await requestJson(harness, '/api/v1/payments/webhook', {
      body: {
        type: 'notification',
        event: 'payment.succeeded',
        object: fullyRefundedPayment,
      },
    });
    assert.equal(delayedSuccess.status, 200);
    const subscription = harness.repository.peekSubscription();
    assert.equal(subscription?.status, 'refunded');
    assert.equal(subscription?.startsAt, null);
    assert.equal(subscription?.expiresAt, null);
    assert.equal(subscription?.autoRenew, false);
    assert.equal(harness.repository.eventCount(), 2);
  } finally {
    await harness.close();
  }
});

test('renewal worker retries a durable creating attempt with the same idempotency key', async () => {
  const harness = await startHarness();
  const subscription: PaymentSubscriptionSnapshot = {
    id: randomUUID(),
    userId: harness.userId,
    provider: 'yukassa',
    status: 'active',
    startsAt: new Date('2026-07-22T12:00:00.000Z'),
    expiresAt: new Date('2026-08-22T00:00:00.000Z'),
    amountMinor: 79_900,
    currency: 'RUB',
    autoRenew: true,
    paymentMethodId: 'saved-method-1',
  };
  harness.repository.seedSubscription(subscription);
  harness.client.configureNextPayment(new YooKassaApiError('temporary outage', 503, true));

  try {
    const first = await harness.renewalService.run();
    assert.equal(first.claimed, 1);
    assert.equal(first.failed, 1);
    assert.equal(harness.notifier.notifications.length, 1);
    const firstKey = harness.client.created[0]?.idempotencyKey;

    const second = await harness.renewalService.run();
    assert.equal(second.claimed, 1);
    assert.equal(second.submitted, 1);
    assert.equal(harness.client.created[1]?.idempotencyKey, firstKey);

    const third = await harness.renewalService.run();
    assert.equal(third.claimed, 0);
    assert.equal(harness.client.created.length, 2);
    console.log('KINETRA_T11_RENEWAL_IDEMPOTENCY=PASS');
  } finally {
    await harness.close();
  }
});

test('definitive renewal cancellation disables auto-renew without revoking paid time', async () => {
  const harness = await startHarness();
  const expiresAt = new Date('2026-08-22T00:00:00.000Z');
  harness.repository.seedSubscription({
    id: randomUUID(),
    userId: harness.userId,
    provider: 'yukassa',
    status: 'active',
    startsAt: new Date('2026-07-22T12:00:00.000Z'),
    expiresAt,
    amountMinor: 79_900,
    currency: 'RUB',
    autoRenew: true,
    paymentMethodId: 'saved-method-cancelled',
  });
  harness.client.configureNextPayment({
    id: randomUUID(),
    status: 'canceled',
    paid: false,
    amount: { value: '799.00', currency: 'RUB' },
    metadata: {},
  });

  try {
    const summary = await harness.renewalService.run();
    assert.equal(summary.failed, 1);
    const subscription = harness.repository.peekSubscription();
    assert.equal(subscription?.status, 'active');
    assert.equal(subscription?.autoRenew, false);
    assert.equal(subscription?.expiresAt?.toISOString(), expiresAt.toISOString());
    assert.equal(harness.notifier.notifications[0]?.reason, 'payment_cancelled');
  } finally {
    await harness.close();
  }
});

test('cancel that wins before renewal execution skips the provider charge', async () => {
  const harness = await startHarness();
  const expiresAt = new Date('2026-08-22T00:00:00.000Z');
  harness.repository.seedSubscription({
    id: randomUUID(),
    userId: harness.userId,
    provider: 'yukassa',
    status: 'active',
    startsAt: new Date('2026-07-22T12:00:00.000Z'),
    expiresAt,
    amountMinor: 79_900,
    currency: 'RUB',
    autoRenew: true,
    paymentMethodId: 'saved-method-cancel-wins',
  });
  harness.repository.setAfterRenewalClaim(async () => {
    await harness.repository.cancelAutoRenew(harness.userId, harness.clock.now());
  });

  try {
    const summary = await harness.renewalService.run();
    assert.deepEqual(summary, {
      expired: 0,
      claimed: 1,
      submitted: 0,
      failed: 0,
      skipped: 1,
    });
    assert.equal(harness.client.created.length, 0);
    assert.equal(harness.repository.peekSubscription()?.status, 'active');
    assert.equal(harness.repository.peekSubscription()?.autoRenew, false);
    assert.equal(
      harness.repository.peekSubscription()?.expiresAt?.toISOString(),
      expiresAt.toISOString(),
    );
  } finally {
    await harness.close();
  }
});

test('cancel waits when renewal execution already owns the serialized claim', async () => {
  const harness = await startHarness();
  const expiresAt = new Date('2026-08-22T00:00:00.000Z');
  harness.repository.seedSubscription({
    id: randomUUID(),
    userId: harness.userId,
    provider: 'yukassa',
    status: 'active',
    startsAt: new Date('2026-07-22T12:00:00.000Z'),
    expiresAt,
    amountMinor: 79_900,
    currency: 'RUB',
    autoRenew: true,
    paymentMethodId: 'saved-method-worker-wins',
  });
  let releaseProvider = (_payment: YooKassaPayment): void => undefined;
  const providerResponse = new Promise<YooKassaPayment>((resolve) => {
    releaseProvider = resolve;
  });
  harness.client.configureNextPayment(providerResponse);

  try {
    const renewal = harness.renewalService.run();

    while (harness.client.created.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    let cancelAcknowledged = false;
    const cancellation = harness.repository
      .cancelAutoRenew(harness.userId, harness.clock.now())
      .then((result) => {
        cancelAcknowledged = true;
        return result;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cancelAcknowledged, false);

    releaseProvider({
      id: randomUUID(),
      status: 'pending',
      paid: false,
      amount: { value: '799.00', currency: 'RUB' },
      metadata: {},
    });
    const [summary, cancelled] = await Promise.all([renewal, cancellation]);
    assert.equal(summary.submitted, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(cancelAcknowledged, true);
    assert.equal(cancelled.subscription?.status, 'active');
    assert.equal(cancelled.subscription?.autoRenew, false);
    assert.equal(cancelled.subscription?.expiresAt?.toISOString(), expiresAt.toISOString());
    console.log('KINETRA_T11_RENEWAL_CANCELLATION_SERIALIZATION=PASS');
  } finally {
    await harness.close();
  }
});
