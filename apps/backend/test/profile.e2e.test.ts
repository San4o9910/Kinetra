import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import type { ProfileRuntime } from '../src/profile/runtime.js';
import { ProfileService } from '../src/profile/service.js';
import { InMemoryProfileRepository } from './support/in-memory-profile.repository.js';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

interface TestHarness {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly repository: InMemoryProfileRepository;
  close(): Promise<void>;
}

const asObject = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
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
    'test-only-profile-access-secret-with-more-than-32-characters',
    'kinetra-profile-test',
    'kinetra-profile-pwa-test',
    900,
  );
  const repository = new InMemoryProfileRepository(userId);
  const profileRuntime: ProfileRuntime = {
    service: new ProfileService(repository),
    authMiddleware: createAuthMiddleware(accessTokens),
  };
  const server = createServer(createApp({ profileRuntime }));

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
    readonly method?: 'GET' | 'PUT';
    readonly body?: unknown;
    readonly token?: string | null;
  } = {},
): Promise<ApiResult> => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

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
  };
};

const validSurvey = {
  gender: 'male',
  age_range: '26-35',
  goal: 'general_health',
  injuries: ['none'],
  experience: 'novice',
} as const;

test('GET /api/v1/me requires a valid access JWT and restores server progress', async () => {
  const harness = await startHarness();

  try {
    const unauthenticated = await requestJson(harness, '/api/v1/me', {
      token: null,
    });
    assert.equal(unauthenticated.status, 401);

    const initial = await requestJson(harness, '/api/v1/me');
    assert.equal(initial.status, 200);
    assert.equal(asObject(asObject(initial.body).user).onboardingStatus, 'survey_pending');
    assert.equal(asObject(initial.body).survey, null);

    const saved = await requestJson(harness, '/api/v1/me/survey', {
      method: 'PUT',
      body: validSurvey,
    });
    assert.equal(saved.status, 200);

    const restored = await requestJson(harness, '/api/v1/me');
    assert.equal(restored.status, 200);
    assert.equal(asObject(asObject(restored.body).user).onboardingStatus, 'onboarding_pending');
    assert.equal(asObject(asObject(restored.body).survey).version, 1);
  } finally {
    await harness.close();
  }
});

test('PUT /api/v1/me/onboarding-complete is JWT-protected and idempotent', async () => {
  const harness = await startHarness();

  try {
    const unauthenticated = await requestJson(harness, '/api/v1/me/onboarding-complete', {
      method: 'PUT',
      token: null,
    });
    assert.equal(unauthenticated.status, 401);

    const surveyPending = await requestJson(harness, '/api/v1/me/onboarding-complete', {
      method: 'PUT',
    });
    assert.equal(surveyPending.status, 200);
    assert.equal(asObject(asObject(surveyPending.body).user).onboardingStatus, 'survey_pending');

    const survey = await requestJson(harness, '/api/v1/me/survey', {
      method: 'PUT',
      body: validSurvey,
    });
    assert.equal(survey.status, 200);
    assert.equal(asObject(asObject(survey.body).user).onboardingStatus, 'onboarding_pending');

    const completed = await requestJson(harness, '/api/v1/me/onboarding-complete', {
      method: 'PUT',
      body: { userId: randomUUID() },
    });
    assert.equal(completed.status, 200);
    assert.equal(asObject(asObject(completed.body).user).onboardingStatus, 'base_lessons');

    const repeated = await requestJson(harness, '/api/v1/me/onboarding-complete', {
      method: 'PUT',
    });
    assert.equal(repeated.status, 200);
    assert.equal(asObject(asObject(repeated.body).user).onboardingStatus, 'base_lessons');

    harness.repository.setOnboardingStatus('active');
    const active = await requestJson(harness, '/api/v1/me/onboarding-complete', {
      method: 'PUT',
    });
    assert.equal(active.status, 200);
    assert.equal(asObject(asObject(active.body).user).onboardingStatus, 'active');
  } finally {
    await harness.close();
  }
});

test('survey validation rejects invalid ranges, incomplete injuries, and body userId overrides', async () => {
  const harness = await startHarness();

  try {
    const invalidAge = await requestJson(harness, '/api/v1/me/survey', {
      method: 'PUT',
      body: { ...validSurvey, age_range: '17-25' },
    });
    assert.equal(invalidAge.status, 400);

    const mixedNone = await requestJson(harness, '/api/v1/me/survey', {
      method: 'PUT',
      body: { ...validSurvey, injuries: ['none', 'knees'] },
    });
    assert.equal(mixedNone.status, 400);

    const otherWithoutDetail = await requestJson(harness, '/api/v1/me/survey', {
      method: 'PUT',
      body: { ...validSurvey, injuries: ['other'] },
    });
    assert.equal(otherWithoutDetail.status, 400);

    const duplicateInjuries = await requestJson(harness, '/api/v1/me/survey', {
      method: 'PUT',
      body: { ...validSurvey, injuries: ['knees', 'knees'] },
    });
    assert.equal(duplicateInjuries.status, 400);

    const oversizedDetail = await requestJson(harness, '/api/v1/me/survey', {
      method: 'PUT',
      body: {
        ...validSurvey,
        injuries: ['other'],
        injuries_detail: 'x'.repeat(501),
      },
    });
    assert.equal(oversizedDetail.status, 400);

    const attemptedOverride = await requestJson(harness, '/api/v1/me/survey', {
      method: 'PUT',
      body: { ...validSurvey, userId: randomUUID() },
    });
    assert.equal(attemptedOverride.status, 400);
    assert.equal(harness.repository.peekSurveyVersions().length, 0);
  } finally {
    await harness.close();
  }
});

test('updating a survey creates a new current version and supersedes the previous one', async () => {
  const harness = await startHarness();

  try {
    const first = await requestJson(harness, '/api/v1/me/survey', {
      method: 'PUT',
      body: validSurvey,
    });
    assert.equal(first.status, 200);

    const second = await requestJson(harness, '/api/v1/me/survey', {
      method: 'PUT',
      body: {
        gender: 'male',
        age_range: '26-35',
        goal: 'strength',
        injuries: ['lower_back', 'other'],
        injuries_detail: 'Ограничение после старой травмы',
        experience: 'experienced',
      },
    });
    assert.equal(second.status, 200);

    const versions = harness.repository.peekSurveyVersions();
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.version, 1);
    assert.equal(versions[0]?.isCurrent, false);
    assert.equal(versions[1]?.version, 2);
    assert.equal(versions[1]?.isCurrent, true);

    const responseSurvey = asObject(asObject(second.body).survey);
    assert.equal(responseSurvey.version, 2);
    assert.equal(responseSurvey.goal, 'strength');
    assert.deepEqual(responseSurvey.injuries, ['lower_back', 'other']);
  } finally {
    await harness.close();
  }
});
