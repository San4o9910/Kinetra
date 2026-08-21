import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiClient } from '../src/lib/api.js';

const session = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'athlete@example.com',
    phone: null,
    emailVerified: true,
    createdAt: '2026-01-10T10:00:00.000Z',
  },
  accessToken: 'settings-token',
  tokenType: 'Bearer' as const,
  expiresIn: 900,
};

test('settings API client uses four exact protected routes and handles 204 responses', async () => {
  const calls: Array<{
    readonly path: string;
    readonly method: string;
    readonly authorization: string | null;
    readonly body: string | null;
    readonly keepalive: boolean;
  }> = [];
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
        keepalive: init?.keepalive === true,
      });

      if (url.pathname === '/api/v1/auth/refresh') {
        return Response.json(session);
      }

      if (url.pathname === '/api/v1/settings/profile') {
        return Response.json({
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
      }

      if (url.pathname === '/api/v1/settings/subscription') {
        return Response.json({
          status: 'none',
          provider: null,
          starts_at: null,
          expires_at: null,
          amount: null,
          currency: null,
          auto_renew: null,
          days_remaining: null,
        });
      }

      if (
        url.pathname === '/api/v1/settings/notifications' ||
        url.pathname === '/api/v1/settings/account'
      ) {
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  assert.equal(await client.bootstrapSession(), true);
  assert.equal((await client.getSettingsProfile()).email, 'athlete@example.com');
  assert.equal((await client.getSubscription()).status, 'none');
  await client.updateNotifications({
    workout_reminders: false,
    reminder_time: '08:30',
    weekly_survey_reminder: true,
  });
  await client.deleteAccount('DELETE');
  assert.equal(client.hasAccessToken(), false);

  assert.deepEqual(
    calls.slice(1).map(({ path, method, authorization }) => ({
      path,
      method,
      authorization,
    })),
    [
      {
        path: '/api/v1/settings/profile',
        method: 'GET',
        authorization: 'Bearer settings-token',
      },
      {
        path: '/api/v1/settings/subscription',
        method: 'GET',
        authorization: 'Bearer settings-token',
      },
      {
        path: '/api/v1/settings/notifications',
        method: 'PUT',
        authorization: 'Bearer settings-token',
      },
      {
        path: '/api/v1/settings/account',
        method: 'DELETE',
        authorization: 'Bearer settings-token',
      },
    ],
  );
  assert.equal(
    calls.at(-2)?.body,
    JSON.stringify({
      workout_reminders: false,
      reminder_time: '08:30',
      weekly_survey_reminder: true,
    }),
  );
  assert.equal(calls.at(-2)?.keepalive, true);
  assert.equal(calls.at(-1)?.body, JSON.stringify({ confirm: 'DELETE' }));
});
