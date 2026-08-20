import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import type { MeResponse, OnboardingStatus } from '@kinetra/shared';

import { createApp } from '../src/app.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import type { BaseLessonsRuntime } from '../src/base-lessons/runtime.js';
import { BaseLessonsService, type ProfileReader } from '../src/base-lessons/service.js';
import { FakeObjectUrlSigner } from './support/fake-object-url-signer.js';
import {
  InMemoryBaseLessonsRepository,
  type InMemoryBaseLessonsRepositoryOptions,
} from './support/in-memory-base-lessons.repository.js';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly cacheControl: string | null;
}

interface TestHarness {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly repository: InMemoryBaseLessonsRepository;
  readonly signer: FakeObjectUrlSigner;
  close(): Promise<void>;
}

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

const profileFor = (userId: string, onboardingStatus: OnboardingStatus): MeResponse => ({
  user: {
    id: userId,
    email: 'base-lessons@example.com',
    phone: null,
    emailVerified: true,
    avatarUrl: null,
    username: 'base-lessons-athlete',
    firstName: 'Алекс',
    onboardingStatus,
    notificationEnabled: true,
    level: 'beginner',
    timezone: 'Europe/Moscow',
    createdAt: '2026-08-20T00:00:00.000Z',
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
});

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

const startHarness = async (
  options: InMemoryBaseLessonsRepositoryOptions = {},
): Promise<TestHarness> => {
  const userId = randomUUID();
  const accessTokens = new HmacJwtAccessTokenService(
    'test-only-base-lessons-secret-with-more-than-32-characters',
    'kinetra-base-lessons-test',
    'kinetra-base-lessons-pwa-test',
    900,
  );
  const repository = new InMemoryBaseLessonsRepository(userId, options);
  const signer = new FakeObjectUrlSigner();
  const profileReader: ProfileReader = {
    getProfile: async (requestedUserId) => {
      assert.equal(requestedUserId, userId);
      return profileFor(userId, repository.status);
    },
  };
  const runtime: BaseLessonsRuntime = {
    service: new BaseLessonsService(repository, signer, profileReader),
    authMiddleware: createAuthMiddleware(accessTokens),
  };
  const server = createServer(createApp({ baseLessonsRuntime: runtime }));

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
    repository,
    signer,
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

test('base lessons endpoints require JWT and list seven ordered placeholder lessons', async () => {
  const harness = await startHarness();

  try {
    for (const [method, path] of [
      ['GET', '/api/v1/base-lessons'],
      ['PUT', `/api/v1/base-lessons/${harness.repository.lessonIds[0]}/progress`],
      ['PUT', '/api/v1/base-lessons/complete-program'],
    ] as const) {
      const response = await requestJson(harness, path, { method, token: null });
      assert.equal(response.status, 401);
      assert.equal(errorCode(response.body), 'AUTHENTICATION_REQUIRED');
    }

    const response = await requestJson(harness, '/api/v1/base-lessons');
    assert.equal(response.status, 200);
    assert.equal(response.cacheControl, 'no-store');
    const body = asObject(response.body);
    assert.equal(body.total_completed, 0);
    assert.equal(body.unlock_threshold, 4);
    assert.equal(body.program_unlocked, false);
    assert.equal(Array.isArray(body.lessons), true);
    const lessons = body.lessons as Record<string, unknown>[];
    assert.equal(lessons.length, 7);
    assert.deepEqual(
      lessons.map((lesson) => lesson.title),
      [
        'Как понять правильно ли я дышу?',
        'Как правильно отжиматься?',
        'Как научиться подтягиваться?',
        'Как приседать?',
        'Как и зачем делать становую тягу?',
        'Я не хочу заниматься каждый день!',
        'Что я ем?',
      ],
    );
    assert.deepEqual(
      lessons.map((lesson) => lesson.order_index),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.deepEqual(
      lessons.map((lesson) => lesson.progress),
      Array.from({ length: 7 }, () => ({ completion_percent: 0, completed: false })),
    );
    assert.equal(
      lessons.every((lesson) => lesson.poster_url === null),
      true,
    );
    assert.equal(
      lessons.every((lesson) => lesson.video_url === null),
      true,
    );
    assert.deepEqual(harness.signer.requestedKeys, []);
  } finally {
    await harness.close();
  }
});

test('base lesson URLs are signed only for configured object keys', async () => {
  const harness = await startHarness({
    firstLessonStorageKey: 'videos/base-lessons/real-01.mp4',
    firstLessonPosterKey: 'posters/base-lessons/real-01.jpg',
  });

  try {
    const response = await requestJson(harness, '/api/v1/base-lessons');
    assert.equal(response.status, 200);
    const lessons = asObject(response.body).lessons as Record<string, unknown>[];
    assert.equal(
      lessons[0]?.video_url,
      'https://storage.kinetra.test/videos%2Fbase-lessons%2Freal-01.mp4',
    );
    assert.equal(
      lessons[0]?.poster_url,
      'https://storage.kinetra.test/posters%2Fbase-lessons%2Freal-01.jpg',
    );
    assert.deepEqual(harness.signer.requestedKeys.sort(), [
      'posters/base-lessons/real-01.jpg',
      'videos/base-lessons/real-01.mp4',
    ]);
  } finally {
    await harness.close();
  }
});

test('progress validation is strict and completion is monotonic at 90 percent', async () => {
  const harness = await startHarness();
  const lessonId = harness.repository.lessonIds[0] as string;

  try {
    for (const body of [
      { position_seconds: -1, completion_percent: 10 },
      { position_seconds: 1.5, completion_percent: 10 },
      { position_seconds: 2_147_483_648, completion_percent: 10 },
      { position_seconds: 10, completion_percent: -1 },
      { position_seconds: 10, completion_percent: 101 },
      { position_seconds: 10, completion_percent: 10, user_id: randomUUID() },
    ]) {
      const response = await requestJson(harness, `/api/v1/base-lessons/${lessonId}/progress`, {
        method: 'PUT',
        body,
      });
      assert.equal(response.status, 400);
      assert.equal(errorCode(response.body), 'INVALID_LESSON_PROGRESS');
    }

    const invalidId = await requestJson(harness, '/api/v1/base-lessons/not-a-uuid/progress', {
      method: 'PUT',
      body: { position_seconds: 10, completion_percent: 10 },
    });
    assert.equal(invalidId.status, 400);
    assert.equal(errorCode(invalidId.body), 'INVALID_LESSON_ID');

    const unknownLesson = await requestJson(
      harness,
      `/api/v1/base-lessons/${randomUUID()}/progress`,
      {
        method: 'PUT',
        body: { position_seconds: 10, completion_percent: 10 },
      },
    );
    assert.equal(unknownLesson.status, 404);
    assert.equal(errorCode(unknownLesson.body), 'BASE_LESSON_NOT_FOUND');

    const started = await requestJson(harness, `/api/v1/base-lessons/${lessonId}/progress`, {
      method: 'PUT',
      body: { position_seconds: 270, completion_percent: 45 },
    });
    assert.equal(started.status, 200);
    assert.equal(asObject(started.body).completed, false);
    assert.equal(asObject(started.body).completed_at, null);

    const startedList = await requestJson(harness, '/api/v1/base-lessons');
    assert.equal(startedList.status, 200);
    assert.equal(asObject(startedList.body).total_completed, 0);
    assert.equal(asObject(startedList.body).program_unlocked, false);
    const startedLessons = asObject(startedList.body).lessons as Record<string, unknown>[];
    assert.deepEqual(startedLessons[0]?.progress, {
      completion_percent: 45,
      completed: false,
    });

    const boundary = await requestJson(harness, `/api/v1/base-lessons/${lessonId}/progress`, {
      method: 'PUT',
      body: { position_seconds: 539, completion_percent: 89.99 },
    });
    assert.equal(boundary.status, 200);
    assert.equal(asObject(boundary.body).completed, false);

    const completed = await requestJson(harness, `/api/v1/base-lessons/${lessonId}/progress`, {
      method: 'PUT',
      body: { position_seconds: 540, completion_percent: 90 },
    });
    assert.equal(completed.status, 200);
    const completedAt = asObject(completed.body).completed_at;
    assert.equal(asObject(completed.body).completed, true);
    assert.equal(typeof completedAt, 'string');

    const stale = await requestJson(harness, `/api/v1/base-lessons/${lessonId}/progress`, {
      method: 'PUT',
      body: { position_seconds: 120, completion_percent: 20 },
    });
    assert.equal(stale.status, 200);
    assert.equal(asObject(stale.body).completion_percent, 90);
    assert.equal(asObject(stale.body).completed_at, completedAt);

    const completedList = await requestJson(harness, '/api/v1/base-lessons');
    assert.equal(completedList.status, 200);
    assert.equal(asObject(completedList.body).total_completed, 1);
    assert.equal(asObject(completedList.body).program_unlocked, false);
    const completedLessons = asObject(completedList.body).lessons as Record<string, unknown>[];
    assert.deepEqual(completedLessons[0]?.progress, {
      completion_percent: 90,
      completed: true,
    });
  } finally {
    await harness.close();
  }
});

test('complete-program enforces four lessons and is idempotent after activation', async () => {
  const harness = await startHarness();

  try {
    for (const lessonId of harness.repository.lessonIds.slice(0, 3)) {
      const progress = await requestJson(harness, `/api/v1/base-lessons/${lessonId}/progress`, {
        method: 'PUT',
        body: { position_seconds: 540, completion_percent: 90 },
      });
      assert.equal(progress.status, 200);
    }

    const locked = await requestJson(harness, '/api/v1/base-lessons/complete-program', {
      method: 'PUT',
    });
    assert.equal(locked.status, 400);
    assert.equal(errorCode(locked.body), 'INSUFFICIENT_LESSONS');
    assert.equal(harness.repository.status, 'base_lessons');

    const fourth = await requestJson(
      harness,
      `/api/v1/base-lessons/${harness.repository.lessonIds[3]}/progress`,
      {
        method: 'PUT',
        body: { position_seconds: 540, completion_percent: 90 },
      },
    );
    assert.equal(fourth.status, 200);

    const unlockedList = await requestJson(harness, '/api/v1/base-lessons');
    assert.equal(asObject(unlockedList.body).total_completed, 4);
    assert.equal(asObject(unlockedList.body).program_unlocked, true);

    const activated = await requestJson(harness, '/api/v1/base-lessons/complete-program', {
      method: 'PUT',
    });
    assert.equal(activated.status, 200);
    assert.equal(asObject(asObject(activated.body).user).onboardingStatus, 'active');

    const repeated = await requestJson(harness, '/api/v1/base-lessons/complete-program', {
      method: 'PUT',
    });
    assert.equal(repeated.status, 200);
    assert.equal(asObject(asObject(repeated.body).user).onboardingStatus, 'active');
    console.log('KINETRA_T06_BACKEND_E2E=PASS');
  } finally {
    await harness.close();
  }
});

test('complete-program cannot bypass an earlier onboarding state', async () => {
  const harness = await startHarness({ onboardingStatus: 'survey_pending' });

  try {
    for (const lessonId of harness.repository.lessonIds.slice(0, 4)) {
      await requestJson(harness, `/api/v1/base-lessons/${lessonId}/progress`, {
        method: 'PUT',
        body: { position_seconds: 600, completion_percent: 100 },
      });
    }

    const response = await requestJson(harness, '/api/v1/base-lessons/complete-program', {
      method: 'PUT',
    });
    assert.equal(response.status, 409);
    assert.equal(errorCode(response.body), 'INVALID_ONBOARDING_STATE');
    assert.equal(harness.repository.status, 'survey_pending');
  } finally {
    await harness.close();
  }
});
