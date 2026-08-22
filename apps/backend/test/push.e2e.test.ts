import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { createFixedWindowRateLimiter } from '../src/auth/rate-limit.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import { MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER } from '../src/push/repository.js';
import type { PushRuntime } from '../src/push/runtime.js';
import { NotificationSchedulerService } from '../src/push/scheduler-service.js';
import { pushEndpointSchema } from '../src/push/schema.js';
import { PushService } from '../src/push/service.js';
import { FakeSubscriptionAccessChecker } from './support/fake-subscription-access-checker.js';
import { InMemoryProgramRepository } from './support/in-memory-program.repository.js';
import { InMemoryProgressRepository } from './support/in-memory-progress.repository.js';
import { InMemoryPushRepository } from './support/in-memory-push.repository.js';
import { FakePushSender } from './support/fake-webpush-sender.js';
import { MutableClock } from './support/test-clock.js';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly cacheControl: string | null;
  readonly retryAfter: string | null;
}

interface TestHarness {
  readonly baseUrl: string;
  readonly userId: string;
  readonly otherUserId: string;
  readonly accessToken: string;
  readonly otherAccessToken: string;
  readonly repository: InMemoryPushRepository;
  close(): Promise<void>;
}

const PUBLIC_KEY = 'P'.repeat(87);
const VALID_SUBSCRIPTION = {
  endpoint: 'https://push.example.test/subscriptions/device-1',
  keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
  expirationTime: null,
} as const;

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

const startHarness = async (
  publicKey: string | null = PUBLIC_KEY,
  maximumMutationRequests = 60,
): Promise<TestHarness> => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const repository = new InMemoryPushRepository([userId, otherUserId]);
  const clock = new MutableClock(new Date('2026-08-22T10:00:00.000Z'));
  const accessTokens = new HmacJwtAccessTokenService(
    'test-only-push-access-secret-with-more-than-32-characters',
    'kinetra-push-test',
    'kinetra-push-pwa-test',
    900,
  );
  const schedulerService = new NotificationSchedulerService(
    repository,
    new InMemoryProgramRepository(userId),
    new InMemoryProgressRepository(userId),
    new FakeSubscriptionAccessChecker(true),
    new FakePushSender(),
    clock,
  );
  const runtime: PushRuntime = {
    service: new PushService(repository, publicKey),
    schedulerService,
    authMiddleware: createAuthMiddleware(accessTokens),
    mutationRateLimiter: createFixedWindowRateLimiter({
      windowMs: 60_000,
      maximumRequests: maximumMutationRequests,
      errorCode: 'PUSH_RATE_LIMITED',
      errorMessage: 'Too many push subscription requests. Try again later.',
    }),
    clock,
    configured: publicKey !== null,
  };
  const server = createServer(createApp({ pushRuntime: runtime }));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Push API test server did not expose a TCP address.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    userId,
    otherUserId,
    accessToken: (await accessTokens.issue(userId, randomUUID(), new Date())).token,
    otherAccessToken: (await accessTokens.issue(otherUserId, randomUUID(), new Date())).token,
    repository,
    close: () => closeServer(server),
  };
};

const requestJson = async (
  harness: TestHarness,
  path: string,
  options: {
    readonly method?: 'GET' | 'POST' | 'DELETE';
    readonly body?: unknown;
    readonly token?: string | null;
    readonly userAgent?: string;
  } = {},
): Promise<ApiResult> => {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? harness.accessToken}`;
  }

  if (options.userAgent !== undefined) {
    headers['user-agent'] = options.userAgent;
  }

  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();

  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
    cacheControl: response.headers.get('cache-control'),
    retryAfter: response.headers.get('retry-after'),
  };
};

test('all Push API endpoints require JWT and disable caching', async () => {
  const harness = await startHarness();

  try {
    for (const [method, path, body] of [
      ['GET', '/api/v1/push/public-key', undefined],
      ['POST', '/api/v1/push/subscriptions', VALID_SUBSCRIPTION],
      ['DELETE', '/api/v1/push/subscriptions', { endpoint: VALID_SUBSCRIPTION.endpoint }],
    ] as const) {
      const response = await requestJson(harness, path, { method, body, token: null });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(errorCode(response.body), 'AUTHENTICATION_REQUIRED');
      assert.equal(response.cacheControl, 'no-store');
    }
  } finally {
    await harness.close();
  }
});

test('Push API returns the public key and idempotently upserts the authenticated device', async () => {
  const harness = await startHarness();

  try {
    const configuration = await requestJson(harness, '/api/v1/push/public-key');
    assert.equal(configuration.status, 200);
    assert.deepEqual(configuration.body, { public_key: PUBLIC_KEY });
    assert.equal(configuration.cacheControl, 'no-store');

    for (const auth of ['B'.repeat(22), 'C'.repeat(22)]) {
      const response = await requestJson(harness, '/api/v1/push/subscriptions', {
        method: 'POST',
        body: { ...VALID_SUBSCRIPTION, keys: { ...VALID_SUBSCRIPTION.keys, auth } },
        userAgent: 'Kinetra Test Browser',
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { subscribed: true });
    }

    const subscriptions = harness.repository.peekSubscriptions();
    assert.equal(subscriptions.length, 1);
    assert.equal(subscriptions[0]?.userId, harness.userId);
    assert.equal(subscriptions[0]?.auth, 'C'.repeat(22));
    assert.equal(subscriptions[0]?.userAgent, 'Kinetra Test Browser');
  } finally {
    await harness.close();
  }
});

test('Push API requires matching keys before transferring an endpoint between JWT users', async () => {
  const harness = await startHarness();

  try {
    const registered = await requestJson(harness, '/api/v1/push/subscriptions', {
      method: 'POST',
      body: VALID_SUBSCRIPTION,
      userAgent: 'First owner browser',
    });
    assert.equal(registered.status, 200);

    for (const keys of [
      { p256dh: VALID_SUBSCRIPTION.keys.p256dh, auth: 'D'.repeat(22) },
      { p256dh: 'C'.repeat(87), auth: VALID_SUBSCRIPTION.keys.auth },
    ]) {
      const rejected = await requestJson(harness, '/api/v1/push/subscriptions', {
        method: 'POST',
        token: harness.otherAccessToken,
        body: {
          ...VALID_SUBSCRIPTION,
          keys,
          expirationTime: 2_000_000_000_000,
        },
        userAgent: 'Conflicting browser',
      });
      assert.equal(rejected.status, 409);
      assert.equal(errorCode(rejected.body), 'PUSH_SUBSCRIPTION_CONFLICT');
    }
    assert.deepEqual(
      harness.repository.peekSubscriptions().map((subscription) => ({
        userId: subscription.userId,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        expirationTime: subscription.expirationTime,
        userAgent: subscription.userAgent,
      })),
      [
        {
          userId: harness.userId,
          p256dh: VALID_SUBSCRIPTION.keys.p256dh,
          auth: VALID_SUBSCRIPTION.keys.auth,
          expirationTime: null,
          userAgent: 'First owner browser',
        },
      ],
    );

    const transferred = await requestJson(harness, '/api/v1/push/subscriptions', {
      method: 'POST',
      token: harness.otherAccessToken,
      body: VALID_SUBSCRIPTION,
      userAgent: 'Second owner browser',
    });
    assert.equal(transferred.status, 200);
    assert.deepEqual(transferred.body, { subscribed: true });
    assert.equal(harness.repository.peekSubscriptions()[0]?.userId, harness.otherUserId);
    assert.equal(harness.repository.peekSubscriptions()[0]?.userAgent, 'Second owner browser');
  } finally {
    await harness.close();
  }
});

test('malformed Push endpoint returns controlled validation instead of throwing', async () => {
  const malformedEndpoint = 'https://[::1';
  assert.doesNotThrow(() => pushEndpointSchema.safeParse(malformedEndpoint));
  assert.equal(pushEndpointSchema.safeParse(malformedEndpoint).success, false);
  const harness = await startHarness();

  try {
    const response = await requestJson(harness, '/api/v1/push/subscriptions', {
      method: 'POST',
      body: { ...VALID_SUBSCRIPTION, endpoint: malformedEndpoint },
    });
    assert.equal(response.status, 400);
    assert.equal(errorCode(response.body), 'INVALID_PUSH_SUBSCRIPTION');
  } finally {
    await harness.close();
  }
});

test('Push API caps enabled devices while rotation and disabling preserve capacity', async () => {
  const harness = await startHarness();
  const subscriptionFor = (device: number) => ({
    ...VALID_SUBSCRIPTION,
    endpoint: `https://push.example.test/subscriptions/capped-device-${device}`,
    expirationTime: device === 0 ? 0 : null,
  });

  try {
    for (let device = 0; device < MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER; device += 1) {
      const registered = await requestJson(harness, '/api/v1/push/subscriptions', {
        method: 'POST',
        body: subscriptionFor(device),
      });
      assert.equal(registered.status, 200, `device ${device + 1}`);
    }

    const overLimit = await requestJson(harness, '/api/v1/push/subscriptions', {
      method: 'POST',
      body: subscriptionFor(MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER),
    });
    assert.equal(overLimit.status, 409);
    assert.equal(errorCode(overLimit.body), 'PUSH_SUBSCRIPTION_CONFLICT');

    const rotatedAtLimit = await requestJson(harness, '/api/v1/push/subscriptions', {
      method: 'POST',
      body: {
        ...subscriptionFor(1),
        keys: { ...VALID_SUBSCRIPTION.keys, auth: 'C'.repeat(22) },
      },
    });
    assert.equal(rotatedAtLimit.status, 200);

    const disabled = await requestJson(harness, '/api/v1/push/subscriptions', {
      method: 'DELETE',
      body: { endpoint: subscriptionFor(0).endpoint },
    });
    assert.equal(disabled.status, 204);

    const registeredAfterDisable = await requestJson(harness, '/api/v1/push/subscriptions', {
      method: 'POST',
      body: subscriptionFor(MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER),
    });
    assert.equal(registeredAfterDisable.status, 200);

    const reactivatedAtLimit = await requestJson(harness, '/api/v1/push/subscriptions', {
      method: 'POST',
      body: {
        ...subscriptionFor(0),
        keys: { ...VALID_SUBSCRIPTION.keys, auth: 'D'.repeat(22) },
      },
    });
    assert.equal(reactivatedAtLimit.status, 409);
    assert.equal(errorCode(reactivatedAtLimit.body), 'PUSH_SUBSCRIPTION_CONFLICT');
    const disabledSubscription = harness.repository
      .peekSubscriptions()
      .find(({ endpoint }) => endpoint === subscriptionFor(0).endpoint);
    assert.equal(disabledSubscription?.disabledAt instanceof Date, true);
    assert.equal(disabledSubscription?.auth, VALID_SUBSCRIPTION.keys.auth);
    assert.equal(
      harness.repository
        .peekSubscriptions()
        .filter(({ userId, disabledAt }) => userId === harness.userId && disabledAt === null)
        .length,
      MAX_ENABLED_PUSH_SUBSCRIPTIONS_PER_USER,
    );
  } finally {
    await harness.close();
  }
});

test('Push subscription validation is strict and rejects local literal endpoints', async () => {
  const harness = await startHarness();

  try {
    for (const body of [
      { ...VALID_SUBSCRIPTION, endpoint: 'http://push.example.test/device' },
      { ...VALID_SUBSCRIPTION, endpoint: 'https://127.0.0.1/device' },
      { ...VALID_SUBSCRIPTION, endpoint: 'https://[::1]/device' },
      { ...VALID_SUBSCRIPTION, endpoint: 'https://localhost/device' },
      {
        ...VALID_SUBSCRIPTION,
        endpoint: `https://push.example.test/${'x'.repeat(4_100)}`,
      },
      { ...VALID_SUBSCRIPTION, keys: { p256dh: 'short', auth: 'short' } },
      {
        ...VALID_SUBSCRIPTION,
        keys: { p256dh: 'A'.repeat(257), auth: 'B'.repeat(129) },
      },
      { ...VALID_SUBSCRIPTION, user_id: harness.userId },
      { ...VALID_SUBSCRIPTION, extra: true },
      { endpoint: VALID_SUBSCRIPTION.endpoint, expirationTime: null },
    ]) {
      const response = await requestJson(harness, '/api/v1/push/subscriptions', {
        method: 'POST',
        body,
      });
      assert.equal(response.status, 400);
      assert.equal(errorCode(response.body), 'INVALID_PUSH_SUBSCRIPTION');
    }

    assert.equal(harness.repository.peekSubscriptions().length, 0);
  } finally {
    await harness.close();
  }
});

test('Push unsubscribe is idempotent and cannot disable another user device', async () => {
  const harness = await startHarness();
  const otherEndpoint = 'https://push.example.test/subscriptions/other-device';

  try {
    await harness.repository.upsertSubscription({
      userId: harness.otherUserId,
      endpoint: otherEndpoint,
      p256dh: 'A'.repeat(87),
      auth: 'B'.repeat(22),
      expirationTime: null,
      userAgent: null,
    });
    await requestJson(harness, '/api/v1/push/subscriptions', {
      method: 'POST',
      body: VALID_SUBSCRIPTION,
    });

    for (const endpoint of [
      otherEndpoint,
      VALID_SUBSCRIPTION.endpoint,
      VALID_SUBSCRIPTION.endpoint,
    ]) {
      const response = await requestJson(harness, '/api/v1/push/subscriptions', {
        method: 'DELETE',
        body: { endpoint },
      });
      assert.equal(response.status, 204);
    }

    const subscriptions = harness.repository.peekSubscriptions();
    assert.equal(
      subscriptions.find(({ endpoint }) => endpoint === otherEndpoint)?.disabledAt,
      null,
    );
    assert.equal(
      subscriptions.find(({ endpoint }) => endpoint === VALID_SUBSCRIPTION.endpoint)
        ?.disabledAt instanceof Date,
      true,
    );
    console.log('KINETRA_T13_BACKEND_E2E=PASS');
  } finally {
    await harness.close();
  }
});

test('Push API fails safely when VAPID is not configured', async () => {
  const harness = await startHarness(null);

  try {
    for (const [method, path, body] of [
      ['GET', '/api/v1/push/public-key', undefined],
      ['POST', '/api/v1/push/subscriptions', VALID_SUBSCRIPTION],
    ] as const) {
      const response = await requestJson(harness, path, { method, body });
      assert.equal(response.status, 503);
      assert.equal(errorCode(response.body), 'PUSH_NOT_CONFIGURED');
      assert.equal(JSON.stringify(response.body).includes('private'), false);
    }
  } finally {
    await harness.close();
  }
});

test('Push subscription mutations have a bounded per-IP rate limit', async () => {
  const harness = await startHarness(PUBLIC_KEY, 2);

  try {
    for (let requestNumber = 0; requestNumber < 2; requestNumber += 1) {
      const allowed = await requestJson(harness, '/api/v1/push/subscriptions', {
        method: 'POST',
        body: VALID_SUBSCRIPTION,
      });
      assert.equal(allowed.status, 200);
    }

    const limited = await requestJson(harness, '/api/v1/push/subscriptions', {
      method: 'DELETE',
      body: { endpoint: VALID_SUBSCRIPTION.endpoint },
    });
    assert.equal(limited.status, 429);
    assert.equal(errorCode(limited.body), 'PUSH_RATE_LIMITED');
    assert.match(limited.retryAfter ?? '', /^\d+$/u);
    assert.equal(limited.cacheControl, 'no-store');
  } finally {
    await harness.close();
  }
});
