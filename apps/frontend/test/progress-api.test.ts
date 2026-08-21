import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthSessionResponse, ProgressResponse } from '@kinetra/shared';

import { ApiClient } from '../src/lib/api.js';

const session: AuthSessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000009',
    email: 'progress@example.com',
    phone: null,
    emailVerified: true,
    createdAt: '2026-08-01T00:00:00.000Z',
  },
  accessToken: 'progress-token',
  tokenType: 'Bearer',
  expiresIn: 900,
};

const progress: ProgressResponse = {
  goal: {
    current_goal: 'general_health',
    goal_label: 'Хочу поддерживать форму и здоровье',
    set_at: '2026-08-01T00:00:00.000Z',
  },
  params: {
    gender: 'male',
    age_range: '26-35',
    experience: 'novice',
    injuries: ['none'],
    survey_updated_at: '2026-08-01T00:00:00.000Z',
  },
  metrics: { current_week: 3, history: [], pending_survey: true },
  achievements: {
    unlocked: [],
    locked: [],
    total_unlocked: 0,
    total_available: 5,
  },
  stats: {
    total_workouts: 0,
    total_weeks_completed: 0,
    current_streak: 0,
    best_streak: 0,
    total_minutes_trained: 0,
  },
};

test('T09 API client sends exact authenticated progress requests and JSON bodies', async () => {
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

      if (url.pathname === '/api/v1/progress/weekly-metrics') {
        return Response.json({
          ...progress.metrics,
          pending_survey: false,
          history: [
            {
              program_week: 3,
              energy: 8,
              sleep: 7,
              mood: 8,
              body_satisfaction: 7,
              note: null,
              created_at: '2026-08-21T12:00:00.000Z',
            },
          ],
        });
      }

      if (url.pathname === '/api/v1/progress/goal') {
        return Response.json({
          current_goal: 'strength',
          goal_label: 'Хочу стать сильнее и выносливее',
          set_at: '2026-08-21T12:00:00.000Z',
        });
      }

      return Response.json(progress);
    },
  });

  assert.equal((await client.getProgress()).metrics.current_week, 3);
  assert.equal(
    (
      await client.submitWeeklyMetrics({
        program_week: 3,
        energy: 8,
        sleep: 7,
        mood: 8,
        body_satisfaction: 7,
      })
    ).pending_survey,
    false,
  );
  assert.equal((await client.updateGoal('strength')).current_goal, 'strength');

  assert.deepEqual(calls.slice(1), [
    {
      path: '/api/v1/progress',
      method: 'GET',
      authorization: 'Bearer progress-token',
      contentType: null,
      body: undefined,
    },
    {
      path: '/api/v1/progress/weekly-metrics',
      method: 'PUT',
      authorization: 'Bearer progress-token',
      contentType: 'application/json',
      body: JSON.stringify({
        program_week: 3,
        energy: 8,
        sleep: 7,
        mood: 8,
        body_satisfaction: 7,
      }),
    },
    {
      path: '/api/v1/progress/goal',
      method: 'PUT',
      authorization: 'Bearer progress-token',
      contentType: 'application/json',
      body: JSON.stringify({ goal: 'strength' }),
    },
  ]);
});
