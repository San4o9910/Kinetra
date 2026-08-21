import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthSessionResponse, ScheduleResponse } from '@kinetra/shared';

import { ApiClient } from '../src/lib/api.js';

const session: AuthSessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'schedule@example.com',
    phone: null,
    emailVerified: true,
    createdAt: '2026-08-21T00:00:00.000Z',
  },
  accessToken: 'schedule-token',
  tokenType: 'Bearer',
  expiresIn: 900,
};

const response: ScheduleResponse = {
  current_week: {
    week_number: 1,
    title: 'Неделя 1',
    days: [
      {
        day_of_week: 1,
        day_label: 'Понедельник',
        direction: 'breathing',
        icon: '🧘',
        title: 'Дыхательная практика',
        description: 'Настройка нервной системы, учимся дышать животом.',
        duration_minutes: 25,
        completed: false,
      },
    ],
    days_completed: 0,
    total_days: 7,
  },
  next_week: null,
};

test('T08 API client sends an authenticated schedule request without a body', async () => {
  const calls: Array<{
    readonly path: string;
    readonly method: string;
    readonly authorization: string | null;
    readonly contentType: string | null;
    readonly body: BodyInit | null | undefined;
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
        contentType: headers.get('content-type'),
        body: init?.body,
      });

      if (url.pathname === '/api/v1/auth/refresh') {
        return Response.json(session);
      }

      return Response.json(response);
    },
  });

  assert.equal((await client.getSchedule()).current_week.week_number, 1);
  assert.deepEqual(calls.slice(1), [
    {
      path: '/api/v1/program/schedule',
      method: 'GET',
      authorization: 'Bearer schedule-token',
      contentType: null,
      body: undefined,
    },
  ]);
});
