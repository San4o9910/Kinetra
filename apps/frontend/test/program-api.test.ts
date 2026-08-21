import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthSessionResponse, WeekResponse } from '@kinetra/shared';

import { ApiClient, ApiRequestError } from '../src/lib/api.js';

const session: AuthSessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'program@example.com',
    phone: null,
    emailVerified: true,
    createdAt: '2026-08-20T00:00:00.000Z',
  },
  accessToken: 'program-token',
  tokenType: 'Bearer',
  expiresIn: 900,
};

const response: WeekResponse = {
  week: {
    id: '10000000-0000-4000-8000-000000000001',
    week_number: 1,
    title: 'Неделя 1',
    status: 'active',
    days: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        day_of_week: 1,
        direction: 'breathing',
        title: 'Дыхание',
        description: 'Описание',
        duration_minutes: 25,
        icon: 'wind',
        video: {
          id: '30000000-0000-4000-8000-000000000001',
          video_url: null,
          poster_url: null,
        },
        completed: false,
        completed_at: null,
      },
    ],
    days_completed: 0,
    total_days: 7,
  },
  total_weeks: 12,
  overall_progress: {
    weeks_completed: 0,
    total_workouts_done: 0,
  },
};

test('T07 API client sends authenticated current, numbered week and completion requests', async () => {
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

  assert.equal((await client.getCurrentWeek()).week.week_number, 1);
  assert.equal((await client.getWeek(2)).total_weeks, 12);
  assert.equal(
    (
      await client.completeWorkout({
        video_id: response.week.days[0]?.video.id ?? '',
        program_week: 1,
      })
    ).week.days_completed,
    0,
  );

  assert.deepEqual(calls.slice(1), [
    {
      path: '/api/v1/program/current-week',
      method: 'GET',
      authorization: 'Bearer program-token',
      contentType: null,
      body: undefined,
    },
    {
      path: '/api/v1/program/weeks/2',
      method: 'GET',
      authorization: 'Bearer program-token',
      contentType: null,
      body: undefined,
    },
    {
      path: '/api/v1/program/complete-workout',
      method: 'PUT',
      authorization: 'Bearer program-token',
      contentType: 'application/json',
      body: JSON.stringify({
        video_id: response.week.days[0]?.video.id ?? '',
        program_week: 1,
      }),
    },
  ]);
});

test('locked future week remains a recoverable domain error', async () => {
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input) => {
      const pathname = new URL(String(input)).pathname;

      if (pathname === '/api/v1/auth/refresh') {
        return Response.json(session);
      }

      return Response.json(
        {
          error: {
            code: 'PROGRAM_WEEK_LOCKED',
            message: 'This program week is not available yet.',
          },
        },
        { status: 403 },
      );
    },
  });

  await assert.rejects(
    client.getWeek(12),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.status === 403 &&
      error.code === 'PROGRAM_WEEK_LOCKED' &&
      error.kind === 'validation',
  );
});
