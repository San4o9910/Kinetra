import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import type { Clock } from '../src/auth/service.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import type { SettingsSubscriptionSnapshot } from '../src/settings/repository.js';
import type { SettingsRuntime } from '../src/settings/runtime.js';
import { SettingsService } from '../src/settings/service.js';
import { InMemorySettingsRepository } from './support/in-memory-settings.repository.js';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly cacheControl: string | null;
  readonly setCookie: string | null;
}

interface TestHarness {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly repository: InMemorySettingsRepository;
  close(): Promise<void>;
}

class FixedClock implements Clock {
  public constructor(private readonly value: Date) {}

  public now(): Date {
    return new Date(this.value.getTime());
  }
}

const asObject = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

const startHarness = async (
  subscription: SettingsSubscriptionSnapshot | null = null,
  paymentsEnabled = true,
  beta = { enabled: false },
): Promise<TestHarness> => {
  const userId = randomUUID();
  const accessTokens = new HmacJwtAccessTokenService(
    'test-only-settings-access-secret-with-more-than-32-characters',
    'kinetra-settings-test',
    'kinetra-settings-pwa-test',
    900,
  );
  const repository = new InMemorySettingsRepository(userId, subscription);
  const settingsRuntime: SettingsRuntime = {
    service: new SettingsService(
      repository,
      new FixedClock(new Date('2026-01-21T00:00:00.000Z')),
      paymentsEnabled,
      {
        hasFreeBetaAccess: async (id) => {
          assert.equal(id, userId);
          return beta.enabled;
        },
      },
    ),
    authMiddleware: createAuthMiddleware(accessTokens),
  };
  const server = createServer(createApp({ settingsRuntime }));

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

  const accessToken = (await accessTokens.issue(userId, randomUUID(), new Date())).token;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    accessToken,
    repository,
    close: () => closeServer(server),
  };
};

const requestJson = async (
  harness: TestHarness,
  path: string,
  options: {
    readonly method?: 'GET' | 'PUT' | 'DELETE';
    readonly body?: unknown;
    readonly token?: string | null;
  } = {},
): Promise<ApiResult> => {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? harness.accessToken}`;
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
    setCookie: response.headers.get('set-cookie'),
  };
};

test('all settings endpoints require a valid access JWT', async () => {
  const harness = await startHarness();

  try {
    for (const [method, path, body] of [
      ['GET', '/api/v1/settings/subscription', undefined],
      ['GET', '/api/v1/settings/profile', undefined],
      [
        'PUT',
        '/api/v1/settings/notifications',
        {
          workout_reminders: true,
          reminder_time: '09:00',
          weekly_survey_reminder: true,
        },
      ],
      ['DELETE', '/api/v1/settings/account', { confirm: 'DELETE' }],
    ] as const) {
      const response = await requestJson(harness, path, {
        method,
        ...(body === undefined ? {} : { body }),
        token: null,
      });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.cacheControl, 'no-store');
    }
  } finally {
    await harness.close();
  }
});

test('settings profile and an absent subscription use canonical defaults', async () => {
  const harness = await startHarness();

  try {
    const profile = await requestJson(harness, '/api/v1/settings/profile');
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body, {
      email: 'athlete@example.com',
      phone: null,
      created_at: '2026-01-10T10:00:00.000Z',
      onboarding_status: 'active',
      notification_preferences: {
        workout_reminders: true,
        reminder_time: '09:00',
        weekly_survey_reminder: true,
      },
    });

    const subscription = await requestJson(harness, '/api/v1/settings/subscription');
    assert.equal(subscription.status, 200);
    assert.deepEqual(subscription.body, {
      status: 'none',
      provider: null,
      starts_at: null,
      expires_at: null,
      amount: null,
      currency: null,
      auto_renew: null,
      days_remaining: null,
    });
  } finally {
    await harness.close();
  }
});

test('subscription response converts minor units and computes remaining days', async () => {
  const harness = await startHarness({
    provider: 'yukassa',
    status: 'active',
    startsAt: new Date('2026-01-15T00:00:00.000Z'),
    expiresAt: new Date('2026-02-15T00:00:00.000Z'),
    amountMinor: 79_900,
    currency: 'RUB',
    autoRenew: true,
  });

  try {
    const response = await requestJson(harness, '/api/v1/settings/subscription');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: 'active',
      provider: 'yukassa',
      starts_at: '2026-01-15T00:00:00.000Z',
      expires_at: '2026-02-15T00:00:00.000Z',
      amount: 799,
      currency: 'RUB',
      auto_renew: true,
      days_remaining: 25,
    });
  } finally {
    await harness.close();
  }
});

test('disabled payment metadata preserves absent, active and expired subscription facts', async () => {
  const subscriptions: (SettingsSubscriptionSnapshot | null)[] = [
    null,
    ...(['active', 'expired'] as const).map((status) => ({
      provider: 'yukassa' as const,
      status,
      startsAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date(
        status === 'active' ? '2026-02-01T00:00:00.000Z' : '2026-01-15T00:00:00.000Z',
      ),
      amountMinor: 79_900,
      currency: 'RUB' as const,
      autoRenew: status === 'active',
    })),
  ];
  for (const subscription of subscriptions) {
    const enabled = await startHarness(subscription);
    const disabled = await startHarness(subscription, false);
    try {
      const original = await requestJson(enabled, '/api/v1/settings/subscription');
      const response = await requestJson(disabled, '/api/v1/settings/subscription');
      assert.equal(response.status, 200);
      assert.equal(response.cacheControl, 'no-store');
      assert.deepEqual(response.body, { ...asObject(original.body), payments_enabled: false });
      const unauthorized = await requestJson(disabled, '/api/v1/settings/subscription', {
        token: null,
      });
      assert.equal(unauthorized.status, 401);
    } finally {
      await Promise.all([enabled.close(), disabled.close()]);
    }
  }
});

test('free beta metadata grants training independently of billing and can be revoked', async () => {
  const beta = { enabled: true };
  const harness = await startHarness(null, false, beta);
  const paidMode = await startHarness(null, true, beta);
  try {
    const result = await requestJson(harness, '/api/v1/settings/subscription');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      status: 'none',
      provider: null,
      starts_at: null,
      expires_at: null,
      amount: null,
      currency: null,
      auto_renew: null,
      days_remaining: null,
      payments_enabled: false,
      training_access: 'free_beta',
    });
    const paid = await requestJson(paidMode, '/api/v1/settings/subscription');
    assert.equal('training_access' in asObject(paid.body), false);
    beta.enabled = false;
    const revoked = await requestJson(harness, '/api/v1/settings/subscription');
    assert.equal(asObject(revoked.body).status, 'none');
    assert.equal(asObject(revoked.body).payments_enabled, false);
    assert.equal('training_access' in asObject(revoked.body), false);
  } finally {
    await Promise.all([harness.close(), paidMode.close()]);
  }
});

test('notification preferences validate strictly and persist as one object', async () => {
  const harness = await startHarness();
  const preferences = {
    workout_reminders: true,
    reminder_time: '06:30',
    weekly_survey_reminder: false,
  };

  try {
    const valid = await requestJson(harness, '/api/v1/settings/notifications', {
      method: 'PUT',
      body: preferences,
    });
    assert.equal(valid.status, 204);
    assert.deepEqual(harness.repository.peekPreferences(), preferences);

    for (const body of [
      { ...preferences, reminder_time: '24:00' },
      { ...preferences, reminder_time: '9:00' },
      { ...preferences, workout_reminders: 'true' },
      { ...preferences, user_id: randomUUID() },
      { workout_reminders: true, reminder_time: '09:00' },
    ]) {
      const invalid = await requestJson(harness, '/api/v1/settings/notifications', {
        method: 'PUT',
        body,
      });
      assert.equal(invalid.status, 400);
      assert.equal(asObject(asObject(invalid.body).error).code, 'INVALID_NOTIFICATION_PREFERENCES');
    }

    assert.deepEqual(harness.repository.peekPreferences(), preferences);
  } finally {
    await harness.close();
  }
});

test('account deletion requires exact confirmation and removes the authenticated profile', async () => {
  const harness = await startHarness();

  try {
    for (const body of [undefined, {}, { confirm: 'delete' }, { confirm: 'DELETE', extra: true }]) {
      const invalid = await requestJson(harness, '/api/v1/settings/account', {
        method: 'DELETE',
        ...(body === undefined ? {} : { body }),
      });
      assert.equal(invalid.status, 400);
      assert.equal(
        asObject(asObject(invalid.body).error).code,
        'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
      );
      assert.equal(harness.repository.isDeleted(), false);
    }

    const deleted = await requestJson(harness, '/api/v1/settings/account', {
      method: 'DELETE',
      body: { confirm: 'DELETE' },
    });
    assert.equal(deleted.status, 204);
    assert.equal(harness.repository.isDeleted(), true);
    assert.match(deleted.setCookie ?? '', /Expires=Thu, 01 Jan 1970 00:00:00 GMT/iu);

    const missing = await requestJson(harness, '/api/v1/settings/profile');
    assert.equal(missing.status, 404);
    console.log('KINETRA_T10_BACKEND_E2E=PASS');
  } finally {
    await harness.close();
  }
});

test('trainer account deletion is managed while conversations remain assigned', async () => {
  const harness = await startHarness();
  harness.repository.setTrainerManaged(true);

  try {
    const response = await requestJson(harness, '/api/v1/settings/account', {
      method: 'DELETE',
      body: { confirm: 'DELETE' },
    });
    assert.equal(response.status, 409);
    assert.equal(asObject(asObject(response.body).error).code, 'TRAINER_ACCOUNT_MANAGED');
    assert.equal(harness.repository.isDeleted(), false);
  } finally {
    await harness.close();
  }
});
