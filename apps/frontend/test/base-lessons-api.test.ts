import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BaseLessonsResponse, MeResponse } from '@kinetra/shared';

import { ApiClient, ApiRequestError } from '../src/lib/api.js';

const session = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'base-lessons@example.com',
    phone: null,
    emailVerified: true,
    createdAt: '2026-08-20T00:00:00.000Z',
  },
  accessToken: 'base-lessons-token',
  tokenType: 'Bearer' as const,
  expiresIn: 900,
};

const activeProfile: MeResponse = {
  user: {
    ...session.user,
    avatarUrl: null,
    username: null,
    firstName: null,
    onboardingStatus: 'active',
    notificationEnabled: true,
    level: 'beginner',
    timezone: 'Europe/Moscow',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
  survey: null,
  subscription: {
    provider: null,
    status: 'none',
    isActive: false,
    startsAt: null,
    expiresAt: null,
    amountMinor: null,
    currency: null,
  },
};

const lessonsResponse: BaseLessonsResponse = {
  lessons: [
    {
      id: '00000000-0000-4000-8000-000000000010',
      slug: 'base-lesson-01-breathing-check',
      title: 'Как понять правильно ли я дышу?',
      description: 'Описание',
      duration_seconds: 600,
      order_index: 1,
      poster_url: null,
      video_url: null,
      progress: { completion_percent: 0, completed: false },
    },
  ],
  total_completed: 0,
  unlock_threshold: 4,
  program_unlocked: false,
};

test('T06 API client sends authenticated GET, progress PUT and complete-program PUT', async () => {
  const calls: Array<{
    readonly path: string;
    readonly method: string;
    readonly authorization: string | null;
    readonly contentType: string | null;
    readonly body: BodyInit | null | undefined;
    readonly keepalive: boolean | undefined;
  }> = [];
  const lessonId = lessonsResponse.lessons[0]?.id ?? '';

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
        keepalive: init?.keepalive,
      });

      if (url.pathname === '/api/v1/auth/refresh') {
        return Response.json(session);
      }

      if (url.pathname === '/api/v1/base-lessons') {
        return Response.json(lessonsResponse);
      }

      if (url.pathname === `/api/v1/base-lessons/${lessonId}/progress`) {
        return Response.json({
          position_seconds: 95,
          completion_percent: 95,
          completed: true,
          completed_at: '2026-08-20T00:00:00.000Z',
        });
      }

      if (url.pathname === '/api/v1/base-lessons/complete-program') {
        return Response.json(activeProfile);
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  assert.equal((await client.getBaseLessons()).lessons.length, 1);
  const updated = await client.updateLessonProgress(lessonId, {
    position_seconds: 95,
    completion_percent: 95,
  });
  assert.equal(updated.completed, true);
  assert.equal((await client.completeBaseProgram()).user.onboardingStatus, 'active');

  assert.deepEqual(calls.slice(1), [
    {
      path: '/api/v1/base-lessons',
      method: 'GET',
      authorization: 'Bearer base-lessons-token',
      contentType: null,
      body: undefined,
      keepalive: undefined,
    },
    {
      path: `/api/v1/base-lessons/${lessonId}/progress`,
      method: 'PUT',
      authorization: 'Bearer base-lessons-token',
      contentType: 'application/json',
      body: JSON.stringify({ position_seconds: 95, completion_percent: 95 }),
      keepalive: true,
    },
    {
      path: '/api/v1/base-lessons/complete-program',
      method: 'PUT',
      authorization: 'Bearer base-lessons-token',
      contentType: null,
      body: undefined,
      keepalive: undefined,
    },
  ]);
});

test('complete-program preserves the INSUFFICIENT_LESSONS server error', async () => {
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
            code: 'INSUFFICIENT_LESSONS',
            message: 'Пройдите минимум 4 базовых урока.',
          },
        },
        { status: 400 },
      );
    },
  });

  await assert.rejects(
    client.completeBaseProgram(),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.status === 400 &&
      error.code === 'INSUFFICIENT_LESSONS' &&
      error.kind === 'validation',
  );
});
