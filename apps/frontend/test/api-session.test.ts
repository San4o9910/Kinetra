import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiClient } from '../src/lib/api.js';

const session = (token: string) => ({
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'test@example.com',
    phone: null,
    emailVerified: true,
    createdAt: '2026-08-20T00:00:00.000Z',
  },
  accessToken: token,
  tokenType: 'Bearer' as const,
  expiresIn: 900,
});

const profile = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'test@example.com',
    phone: null,
    emailVerified: true,
    avatarUrl: null,
    username: null,
    firstName: null,
    onboardingStatus: 'survey_pending' as const,
    notificationEnabled: true,
    level: 'beginner' as const,
    timezone: 'Europe/Moscow',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
  survey: null,
  subscription: {
    provider: null,
    status: 'none' as const,
    isActive: false,
    startsAt: null,
    expiresAt: null,
    amountMinor: null,
    currency: null,
  },
};

test('protected request refreshes once after a 401 and retries with the new access token', async () => {
  const calls: Array<{ readonly path: string; readonly authorization: string | null }> = [];
  let refreshCount = 0;
  let meCount = 0;

  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({ path: url.pathname, authorization: headers.get('authorization') });

      if (url.pathname === '/api/v1/auth/refresh') {
        refreshCount += 1;
        return Response.json(session(`fresh-${refreshCount}`));
      }

      if (url.pathname === '/api/v1/me') {
        meCount += 1;
        if (meCount === 1) {
          return Response.json(
            { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Expired.' } },
            { status: 401 },
          );
        }
        return Response.json(profile);
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  assert.equal(await client.bootstrapSession(), true);
  const result = await client.fetchMe();
  assert.equal(result.user.onboardingStatus, 'survey_pending');
  assert.equal(refreshCount, 2);
  assert.equal(calls.at(-1)?.authorization, 'Bearer fresh-2');
});

test('concurrent bootstrap calls share one refresh rotation', async () => {
  let refreshCount = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async () => {
      refreshCount += 1;
      await gate;
      return Response.json(session('shared-token'));
    },
  });

  const first = client.bootstrapSession();
  const second = client.bootstrapSession();
  release?.();

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(refreshCount, 1);
});
