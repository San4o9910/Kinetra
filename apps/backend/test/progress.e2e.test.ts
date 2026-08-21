import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import type { ProgressRuntime } from '../src/progress/runtime.js';
import { ProgressService } from '../src/progress/service.js';
import { InMemoryProgramRepository } from './support/in-memory-program.repository.js';
import { InMemoryProgressRepository } from './support/in-memory-progress.repository.js';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly cacheControl: string | null;
}

interface TestHarness {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly userId: string;
  readonly repository: InMemoryProgressRepository;
  readonly programRepository: InMemoryProgramRepository;
  close(): Promise<void>;
}

const asObject = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
};

const asObjects = (value: unknown): readonly Record<string, unknown>[] => {
  assert.equal(Array.isArray(value), true);
  return value as readonly Record<string, unknown>[];
};

const errorCode = (body: unknown): string => {
  const error = asObject(asObject(body).error);
  assert.equal(typeof error.code, 'string');
  return error.code as string;
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
};

const startHarness = async (): Promise<TestHarness> => {
  const userId = randomUUID();
  const accessTokens = new HmacJwtAccessTokenService(
    'test-only-progress-secret-with-more-than-32-characters',
    'kinetra-progress-test',
    'kinetra-progress-pwa-test',
    900,
  );
  const repository = new InMemoryProgressRepository(userId);
  const programRepository = new InMemoryProgramRepository(userId);
  const runtime: ProgressRuntime = {
    service: new ProgressService(repository, programRepository),
    authMiddleware: createAuthMiddleware(accessTokens),
  };
  const server = createServer(createApp({ progressRuntime: runtime }));

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
    accessToken: (await accessTokens.issue(userId, randomUUID(), new Date())).token,
    userId,
    repository,
    programRepository,
    close: () => closeServer(server),
  };
};

const requestJson = async (
  harness: TestHarness,
  path: string,
  options: {
    readonly method?: 'GET' | 'PUT';
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
  };
};

const validMetric = {
  program_week: 1,
  energy: 8,
  sleep: 7,
  mood: 8,
  body_satisfaction: 7,
  note: 'Чувствую прилив сил',
} as const;

test('progress endpoints require an access token and disable caching', async () => {
  const harness = await startHarness();

  try {
    for (const [method, path, body] of [
      ['GET', '/api/v1/progress', undefined],
      ['PUT', '/api/v1/progress/weekly-metrics', validMetric],
      ['PUT', '/api/v1/progress/goal', { goal: 'strength' }],
    ] as const) {
      const response = await requestJson(harness, path, { method, body, token: null });
      assert.equal(response.status, 401);
      assert.equal(errorCode(response.body), 'AUTHENTICATION_REQUIRED');
      assert.equal(response.cacheControl, 'no-store');
    }
  } finally {
    await harness.close();
  }
});

test('empty progress returns survey data, five locked achievements and zero statistics', async () => {
  const harness = await startHarness();

  try {
    const response = await requestJson(harness, '/api/v1/progress');
    assert.equal(response.status, 200);
    assert.equal(response.cacheControl, 'no-store');
    const body = asObject(response.body);
    assert.deepEqual(body.goal, {
      current_goal: 'flexibility',
      goal_label: 'Хочу быть гибким и подвижным',
      set_at: '2026-01-15T10:00:00.000Z',
    });
    assert.deepEqual(body.params, {
      gender: 'male',
      age_range: '26-35',
      experience: 'beginner',
      injuries: ['knees'],
      survey_updated_at: '2026-01-15T10:00:00.000Z',
    });
    assert.deepEqual(body.metrics, {
      current_week: 1,
      history: [],
      pending_survey: true,
    });
    const achievements = asObject(body.achievements);
    assert.deepEqual(achievements.unlocked, []);
    assert.equal(asObjects(achievements.locked).length, 5);
    assert.deepEqual(
      asObjects(achievements.locked).map(({ code, progress }) => ({ code, progress })),
      [
        { code: 'first_base_lesson', progress: '0/1' },
        { code: 'base_unlocked', progress: '0/4' },
        { code: 'first_workout', progress: '0/1' },
        { code: 'week_complete', progress: '0/7' },
        { code: 'streak_3', progress: '0/3' },
      ],
    );
    assert.equal(achievements.total_unlocked, 0);
    assert.equal(achievements.total_available, 5);
    assert.deepEqual(body.stats, {
      total_workouts: 0,
      total_weeks_completed: 0,
      current_streak: 0,
      best_streak: 0,
      total_minutes_trained: 0,
    });
  } finally {
    await harness.close();
  }
});

test('weekly metrics validate strictly, upsert one week and preserve ordered history', async () => {
  const harness = await startHarness();

  try {
    const invalidBodies: readonly unknown[] = [
      { ...validMetric, program_week: 0 },
      { ...validMetric, program_week: 13 },
      { ...validMetric, program_week: 1.5 },
      { ...validMetric, program_week: '1' },
      { ...validMetric, energy: 0 },
      { ...validMetric, sleep: 11 },
      { ...validMetric, mood: 7.5 },
      { ...validMetric, body_satisfaction: '7' },
      { ...validMetric, note: 'x'.repeat(501) },
      { ...validMetric, user_id: harness.userId },
      { program_week: 1, energy: 8, sleep: 7, mood: 8 },
    ];

    for (const body of invalidBodies) {
      const response = await requestJson(harness, '/api/v1/progress/weekly-metrics', {
        method: 'PUT',
        body,
      });
      assert.equal(response.status, 400);
      assert.equal(errorCode(response.body), 'INVALID_WEEKLY_METRICS');
    }

    const weekTwo = await requestJson(harness, '/api/v1/progress/weekly-metrics', {
      method: 'PUT',
      body: { ...validMetric, program_week: 2, energy: 6 },
    });
    assert.equal(weekTwo.status, 200);
    assert.equal(asObject(weekTwo.body).pending_survey, true);

    const first = await requestJson(harness, '/api/v1/progress/weekly-metrics', {
      method: 'PUT',
      body: validMetric,
    });
    assert.equal(first.status, 200);
    assert.equal(asObject(first.body).pending_survey, false);
    assert.deepEqual(
      asObjects(asObject(first.body).history).map((metric) => metric.program_week),
      [1, 2],
    );

    const updated = await requestJson(harness, '/api/v1/progress/weekly-metrics', {
      method: 'PUT',
      body: { ...validMetric, energy: 9, note: 'Обновлённая заметка' },
    });
    const history = asObjects(asObject(updated.body).history);
    assert.equal(history.length, 2);
    assert.equal(history[0]?.energy, 9);
    assert.equal(history[0]?.note, 'Обновлённая заметка');
    assert.equal(history[0]?.created_at, '2026-02-01T18:00:00.000Z');
  } finally {
    await harness.close();
  }
});

test('pending survey follows the authoritative current program week', async () => {
  const harness = await startHarness();

  try {
    for (const videoId of harness.programRepository.videoIdsForWeek(1)) {
      await harness.programRepository.completeWorkout(harness.userId, videoId, 1);
    }

    const pastWeek = await requestJson(harness, '/api/v1/progress/weekly-metrics', {
      method: 'PUT',
      body: validMetric,
    });
    assert.equal(asObject(pastWeek.body).current_week, 2);
    assert.equal(asObject(pastWeek.body).pending_survey, true);

    const currentWeek = await requestJson(harness, '/api/v1/progress/weekly-metrics', {
      method: 'PUT',
      body: { ...validMetric, program_week: 2 },
    });
    assert.equal(asObject(currentWeek.body).current_week, 2);
    assert.equal(asObject(currentWeek.body).pending_survey, false);
  } finally {
    await harness.close();
  }
});

test('goal update creates a new current survey version and preserves all other answers', async () => {
  const harness = await startHarness();

  try {
    for (const body of [
      { goal: 'unsupported' },
      { goal: 'strength', user_id: harness.userId },
      {},
    ]) {
      const invalid = await requestJson(harness, '/api/v1/progress/goal', {
        method: 'PUT',
        body,
      });
      assert.equal(invalid.status, 400);
      assert.equal(errorCode(invalid.body), 'INVALID_PROGRESS_GOAL');
    }

    const response = await requestJson(harness, '/api/v1/progress/goal', {
      method: 'PUT',
      body: { goal: 'strength' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      current_goal: 'strength',
      goal_label: 'Хочу стать сильнее и выносливее',
      set_at: '2026-03-02T10:00:00.000Z',
    });

    const versions = harness.repository.peekSurveyVersions();
    assert.equal(versions.length, 2);
    assert.deepEqual(
      versions.map(({ version, isCurrent }) => ({ version, isCurrent })),
      [
        { version: 1, isCurrent: false },
        { version: 2, isCurrent: true },
      ],
    );
    assert.equal(versions[1]?.survey.gender, 'male');
    assert.equal(versions[1]?.survey.ageRange, '26-35');
    assert.deepEqual(versions[1]?.survey.injuries, ['knees']);
    assert.equal(versions[1]?.survey.experience, 'beginner');
  } finally {
    await harness.close();
  }
});

test('progress splits materialized achievements and exposes aggregate statistics', async () => {
  const harness = await startHarness();

  try {
    harness.repository.setAchievementProgress('first_base_lesson', 4);
    harness.repository.setAchievementProgress('base_unlocked', 4);
    harness.repository.setAchievementProgress('first_workout', 0);
    harness.repository.setAchievementProgress('week_complete', 2);
    harness.repository.setAchievementProgress('streak_3', 1);
    harness.repository.setStats({
      totalWorkouts: 15,
      totalWeeksCompleted: 2,
      currentStreak: 3,
      bestStreak: 5,
      totalMinutesTrained: 450,
    });

    const first = await requestJson(harness, '/api/v1/progress');
    const body = asObject(first.body);
    const achievements = asObject(body.achievements);
    assert.deepEqual(
      asObjects(achievements.unlocked).map(({ code, icon_key }) => ({ code, icon_key })),
      [
        { code: 'first_base_lesson', icon_key: '🎯' },
        { code: 'base_unlocked', icon_key: '🔓' },
      ],
    );
    assert.deepEqual(
      asObjects(achievements.locked).map(({ code, progress }) => ({ code, progress })),
      [
        { code: 'first_workout', progress: '0/1' },
        { code: 'week_complete', progress: '2/7' },
        { code: 'streak_3', progress: '1/3' },
      ],
    );
    assert.equal(achievements.total_unlocked, 2);
    assert.equal(achievements.total_available, 5);
    assert.deepEqual(body.stats, {
      total_workouts: 15,
      total_weeks_completed: 2,
      current_streak: 3,
      best_streak: 5,
      total_minutes_trained: 450,
    });

    const firstUnlockedAt = asObjects(achievements.unlocked)[0]?.unlocked_at;
    const repeated = await requestJson(harness, '/api/v1/progress');
    assert.equal(
      asObjects(asObject(asObject(repeated.body).achievements).unlocked)[0]?.unlocked_at,
      firstUnlockedAt,
    );
  } finally {
    await harness.close();
  }
});

test('progress requires a current survey even for an authenticated user', async () => {
  const harness = await startHarness();

  try {
    harness.repository.clearSurvey();
    const response = await requestJson(harness, '/api/v1/progress');
    assert.equal(response.status, 409);
    assert.equal(errorCode(response.body), 'SURVEY_REQUIRED');
  } finally {
    await harness.close();
  }
});

test('T09 backend acceptance marker', () => {
  console.log('KINETRA_T09_BACKEND_E2E=PASS');
});
