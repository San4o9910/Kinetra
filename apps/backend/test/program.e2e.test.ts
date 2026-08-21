import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import type { ProgramRuntime } from '../src/program/runtime.js';
import { ProgramService } from '../src/program/service.js';
import { FakeObjectUrlSigner } from './support/fake-object-url-signer.js';
import { InMemoryProgramRepository } from './support/in-memory-program.repository.js';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly cacheControl: string | null;
}

interface TestHarness {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly repository: InMemoryProgramRepository;
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
    'test-only-program-secret-with-more-than-32-characters',
    'kinetra-program-test',
    'kinetra-program-pwa-test',
    900,
  );
  const repository = new InMemoryProgramRepository(userId);
  const signer = new FakeObjectUrlSigner();
  const runtime: ProgramRuntime = {
    service: new ProgramService(repository, signer),
    authMiddleware: createAuthMiddleware(accessTokens),
  };
  const server = createServer(createApp({ programRuntime: runtime }));

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

test('program endpoints require an access token', async () => {
  const harness = await startHarness();

  try {
    for (const [method, path, body] of [
      ['GET', '/api/v1/program/current-week', undefined],
      ['GET', '/api/v1/program/weeks/1', undefined],
      [
        'PUT',
        '/api/v1/program/complete-workout',
        { video_id: harness.repository.videoIdsForWeek(1)[0], program_week: 1 },
      ],
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

test('current week defaults to week one and exposes seven ordered workout days', async () => {
  const harness = await startHarness();

  try {
    const response = await requestJson(harness, '/api/v1/program/current-week');
    assert.equal(response.status, 200);
    assert.equal(response.cacheControl, 'no-store');
    const body = asObject(response.body);
    const week = asObject(body.week);
    assert.equal(week.week_number, 1);
    assert.equal(week.title, 'Неделя 1');
    assert.equal(week.status, 'active');
    assert.equal(week.days_completed, 0);
    assert.equal(week.total_days, 7);
    assert.equal(body.total_weeks, 12);
    assert.deepEqual(body.overall_progress, {
      weeks_completed: 0,
      total_workouts_done: 0,
    });
    const days = week.days as Record<string, unknown>[];
    assert.equal(days.length, 7);
    assert.deepEqual(
      days.map((day) => day.day_of_week),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.deepEqual(
      days.map((day) => day.direction),
      ['breathing', 'strength', 'body_therapy', 'functional', 'stretching', 'neuro', 'recovery'],
    );
    assert.deepEqual(
      days.map((day) => day.icon),
      ['🧘', '💪', '🌿', '⚡', '🧘‍♂️', '🧠', '🍲'],
    );
    assert.equal(
      days.every((day) => day.completed === false),
      true,
    );
    assert.equal(
      days.every((day) => day.completed_at === null),
      true,
    );
    assert.equal(
      days.every((day) => {
        const video = asObject(day.video);
        return video.video_url === null && video.poster_url === null;
      }),
      true,
    );
  } finally {
    await harness.close();
  }
});

test('specific week access allows only the current week and the next locked week', async () => {
  const harness = await startHarness();

  try {
    const current = await requestJson(harness, '/api/v1/program/weeks/1');
    assert.equal(current.status, 200);
    assert.equal(asObject(asObject(current.body).week).status, 'active');

    const next = await requestJson(harness, '/api/v1/program/weeks/2');
    assert.equal(next.status, 200);
    const nextWeek = asObject(asObject(next.body).week);
    assert.equal(nextWeek.week_number, 2);
    assert.equal(nextWeek.status, 'locked');

    const future = await requestJson(harness, '/api/v1/program/weeks/3');
    assert.equal(future.status, 403);
    assert.equal(errorCode(future.body), 'PROGRAM_WEEK_LOCKED');

    for (const invalidWeek of ['0', '13', '1.5', 'not-a-week']) {
      const invalid = await requestJson(harness, `/api/v1/program/weeks/${invalidWeek}`);
      assert.equal(invalid.status, 400);
      assert.equal(errorCode(invalid.body), 'INVALID_WEEK_NUMBER');
    }
  } finally {
    await harness.close();
  }
});

test('workout media URLs require both availability and an unlocked week', async () => {
  const harness = await startHarness();
  const currentVideoId = harness.repository.videoIdsForWeek(1)[0] as string;
  const lockedVideoId = harness.repository.videoIdsForWeek(2)[0] as string;

  try {
    harness.repository.markMediaAvailable(1, currentVideoId);
    harness.repository.markMediaAvailable(2, lockedVideoId);

    const current = await requestJson(harness, '/api/v1/program/current-week');
    const currentDays = asObject(asObject(current.body).week).days as Record<string, unknown>[];
    const currentVideo = asObject(currentDays[0]?.video);
    assert.match(String(currentVideo.video_url), /^https:\/\/storage\.kinetra\.test\//u);
    assert.match(String(currentVideo.poster_url), /^https:\/\/storage\.kinetra\.test\//u);
    assert.equal(harness.signer.requestedKeys.length, 2);

    const locked = await requestJson(harness, '/api/v1/program/weeks/2');
    const lockedDays = asObject(asObject(locked.body).week).days as Record<string, unknown>[];
    const lockedVideo = asObject(lockedDays[0]?.video);
    assert.equal(lockedVideo.video_url, null);
    assert.equal(lockedVideo.poster_url, null);
    assert.equal(harness.signer.requestedKeys.length, 2);
  } finally {
    await harness.close();
  }
});

test('workout completion is strict, validates schedule membership, and is idempotent', async () => {
  const harness = await startHarness();
  const videoId = harness.repository.videoIdsForWeek(1)[0] as string;

  try {
    for (const body of [
      { video_id: 'not-a-uuid', program_week: 1 },
      { video_id: videoId, program_week: 0 },
      { video_id: videoId, program_week: 13 },
      { video_id: videoId, program_week: 1, user_id: randomUUID() },
    ]) {
      const invalid = await requestJson(harness, '/api/v1/program/complete-workout', {
        method: 'PUT',
        body,
      });
      assert.equal(invalid.status, 400);
      assert.equal(errorCode(invalid.body), 'INVALID_WORKOUT_COMPLETION');
    }

    const mismatched = await requestJson(harness, '/api/v1/program/complete-workout', {
      method: 'PUT',
      body: { video_id: harness.repository.videoIdsForWeek(2)[0], program_week: 1 },
    });
    assert.equal(mismatched.status, 404);
    assert.equal(errorCode(mismatched.body), 'WORKOUT_NOT_FOUND');

    const locked = await requestJson(harness, '/api/v1/program/complete-workout', {
      method: 'PUT',
      body: { video_id: harness.repository.videoIdsForWeek(2)[0], program_week: 2 },
    });
    assert.equal(locked.status, 403);
    assert.equal(errorCode(locked.body), 'PROGRAM_WEEK_LOCKED');

    for (let repetition = 0; repetition < 2; repetition += 1) {
      const completed = await requestJson(harness, '/api/v1/program/complete-workout', {
        method: 'PUT',
        body: { video_id: videoId, program_week: 1 },
      });
      assert.equal(completed.status, 200);
      const body = asObject(completed.body);
      const week = asObject(body.week);
      assert.equal(week.week_number, 1);
      assert.equal(week.days_completed, 1);
      assert.deepEqual(body.overall_progress, {
        weeks_completed: 0,
        total_workouts_done: 1,
      });
      const firstDay = (week.days as Record<string, unknown>[])[0];
      assert.equal(firstDay?.completed, true);
      assert.equal(firstDay?.completed_at, '2026-08-20T12:00:00.000Z');
    }
  } finally {
    await harness.close();
  }
});

test('completing all seven workouts advances and caps the current program week', async () => {
  const harness = await startHarness();

  try {
    let response: ApiResult | null = null;

    for (const videoId of harness.repository.videoIdsForWeek(1)) {
      response = await requestJson(harness, '/api/v1/program/complete-workout', {
        method: 'PUT',
        body: { video_id: videoId, program_week: 1 },
      });
      assert.equal(response.status, 200);
    }

    assert.notEqual(response, null);
    const body = asObject(response?.body);
    const week = asObject(body.week);
    assert.equal(week.week_number, 2);
    assert.equal(week.status, 'active');
    assert.equal(week.days_completed, 0);
    assert.deepEqual(body.overall_progress, {
      weeks_completed: 1,
      total_workouts_done: 7,
    });

    const lastWeekOneVideoId = harness.repository.videoIdsForWeek(1)[6] as string;
    const retriedAfterAdvance = await requestJson(harness, '/api/v1/program/complete-workout', {
      method: 'PUT',
      body: { video_id: lastWeekOneVideoId, program_week: 1 },
    });
    assert.equal(retriedAfterAdvance.status, 200);
    assert.equal(asObject(asObject(retriedAfterAdvance.body).week).week_number, 2);
    assert.deepEqual(asObject(retriedAfterAdvance.body).overall_progress, {
      weeks_completed: 1,
      total_workouts_done: 7,
    });

    const previous = await requestJson(harness, '/api/v1/program/weeks/1');
    assert.equal(previous.status, 200);
    assert.equal(asObject(asObject(previous.body).week).status, 'completed');

    for (let weekNumber = 2; weekNumber <= 12; weekNumber += 1) {
      for (const videoId of harness.repository.videoIdsForWeek(weekNumber)) {
        response = await requestJson(harness, '/api/v1/program/complete-workout', {
          method: 'PUT',
          body: { video_id: videoId, program_week: weekNumber },
        });
        assert.equal(response.status, 200);
      }
    }

    const capped = asObject(response?.body);
    assert.equal(asObject(capped.week).week_number, 12);
    assert.equal(asObject(capped.week).status, 'completed');
    assert.equal(asObject(capped.week).days_completed, 7);
    assert.deepEqual(capped.overall_progress, {
      weeks_completed: 12,
      total_workouts_done: 84,
    });
    console.log('KINETRA_T07_BACKEND_E2E=PASS');
  } finally {
    await harness.close();
  }
});
