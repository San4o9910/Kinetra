import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import type {
  ReviewerMutationResult,
  TrainerVerificationApplicationInputRecord,
  TrainerVerificationListResult,
  TrainerVerificationRepository,
  TrainerVerificationRequestSnapshot,
  TrainerVerificationReviewAction,
  TrainerVerificationReviewResult,
  TrainerVerificationUserMutationResult,
  TrainerVerificationUserSnapshot,
} from '../src/trainer-verification/repository.js';
import type { TrainerVerificationRuntime } from '../src/trainer-verification/runtime.js';
import { TrainerVerificationService } from '../src/trainer-verification/service.js';
import { MutableClock } from './support/test-clock.js';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

interface TestHarness {
  readonly baseUrl: string;
  readonly applicantToken: string;
  readonly reviewerToken: string;
  readonly outsiderToken: string;
  readonly traineeToken: string;
  close(): Promise<void>;
}

const APPLICANT_ID = '00000000-0000-4000-8000-000000000101';
const REVIEWER_ID = '00000000-0000-4000-8000-000000000102';
const OUTSIDER_ID = '00000000-0000-4000-8000-000000000103';
const TRAINEE_ID = '00000000-0000-4000-8000-000000000104';

const asObject = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
};

const errorCode = (body: unknown): string => String(asObject(asObject(body).error).code);

const cloneRequest = (
  request: TrainerVerificationRequestSnapshot,
): TrainerVerificationRequestSnapshot => ({
  ...request,
  createdAt: new Date(request.createdAt),
  updatedAt: new Date(request.updatedAt),
  submittedAt: request.submittedAt === null ? null : new Date(request.submittedAt),
  reviewedAt: request.reviewedAt === null ? null : new Date(request.reviewedAt),
  materials: request.materials.map((material) => ({
    ...material,
    createdAt: new Date(material.createdAt),
  })),
});

class InMemoryTrainerVerificationRepository implements TrainerVerificationRepository {
  private readonly requestedRoles = new Map([
    [APPLICANT_ID, 'trainer' as const],
    [REVIEWER_ID, 'trainee' as const],
    [OUTSIDER_ID, 'trainee' as const],
    [TRAINEE_ID, 'trainee' as const],
  ]);
  private readonly reviewers = new Set([REVIEWER_ID]);
  private readonly activeTrainerProfiles = new Set<string>();
  private readonly requests = new Map<string, TrainerVerificationRequestSnapshot[]>();
  private requestSequence = 0;
  private applicantEmailVerified = true;

  public async findForUser(userId: string): Promise<TrainerVerificationUserSnapshot | null> {
    const requestedRole = this.requestedRoles.get(userId);
    if (requestedRole === undefined) return null;
    const requests = this.requests.get(userId) ?? [];
    const request = requests.at(-1);
    return {
      requestedRole,
      hasActiveTrainerProfile: this.activeTrainerProfiles.has(userId),
      request: request === undefined ? null : cloneRequest(request),
    };
  }

  public async submit(
    userId: string,
    input: TrainerVerificationApplicationInputRecord,
    now: Date,
  ): Promise<TrainerVerificationUserMutationResult> {
    const requestedRole = this.requestedRoles.get(userId);
    if (requestedRole === undefined) return { status: 'user_not_found' };
    if (requestedRole !== 'trainer') return { status: 'role_not_trainer' };
    const requests = this.requests.get(userId) ?? [];
    const latest = requests.at(-1);

    if (
      latest !== undefined &&
      !(latest.status === 'pending' && latest.submittedAt === null) &&
      latest.status !== 'rejected' &&
      latest.status !== 'withdrawn'
    ) {
      return { status: 'invalid_state' };
    }

    const request = this.applicationRequest(
      userId,
      input,
      now,
      latest?.status === 'pending' && latest.submittedAt === null ? latest.id : undefined,
    );
    if (latest?.status === 'pending' && latest.submittedAt === null) {
      requests[requests.length - 1] = request;
    } else {
      requests.push(request);
    }
    this.requests.set(userId, requests);
    return {
      status: 'ok',
      value: {
        requestedRole,
        hasActiveTrainerProfile: this.activeTrainerProfiles.has(userId),
        request: cloneRequest(request),
      },
    };
  }

  public async update(
    userId: string,
    input: TrainerVerificationApplicationInputRecord,
    now: Date,
  ): Promise<TrainerVerificationUserMutationResult> {
    const requestedRole = this.requestedRoles.get(userId);
    if (requestedRole === undefined) return { status: 'user_not_found' };
    if (requestedRole !== 'trainer') return { status: 'role_not_trainer' };
    const requests = this.requests.get(userId) ?? [];
    const latest = requests.at(-1);
    if (latest === undefined) return { status: 'request_not_found' };
    if (latest.status !== 'needs_more_info') return { status: 'invalid_state' };
    const request = this.applicationRequest(userId, input, now, latest.id);
    requests[requests.length - 1] = request;
    return {
      status: 'ok',
      value: {
        requestedRole,
        hasActiveTrainerProfile: this.activeTrainerProfiles.has(userId),
        request: cloneRequest(request),
      },
    };
  }

  public async withdraw(userId: string, now: Date): Promise<TrainerVerificationUserMutationResult> {
    const requestedRole = this.requestedRoles.get(userId);
    if (requestedRole === undefined) return { status: 'user_not_found' };
    if (requestedRole !== 'trainer') return { status: 'role_not_trainer' };
    const requests = this.requests.get(userId) ?? [];
    const latest = requests.at(-1);
    if (latest === undefined) return { status: 'request_not_found' };
    if (
      latest.submittedAt === null ||
      (latest.status !== 'pending' && latest.status !== 'needs_more_info')
    ) {
      return { status: 'invalid_state' };
    }
    const request: TrainerVerificationRequestSnapshot = {
      ...latest,
      status: 'withdrawn',
      reviewedAt: null,
      reviewerUserId: null,
      reviewReason: null,
      updatedAt: new Date(now),
    };
    requests[requests.length - 1] = request;
    return {
      status: 'ok',
      value: {
        requestedRole,
        hasActiveTrainerProfile: this.activeTrainerProfiles.has(userId),
        request: cloneRequest(request),
      },
    };
  }

  public async listForReviewer(
    reviewerUserId: string,
    status: TrainerVerificationRequestSnapshot['status'] | null,
  ): Promise<TrainerVerificationListResult> {
    if (!this.reviewers.has(reviewerUserId)) return { status: 'not_reviewer' };
    const requests = [...this.requests.values()]
      .flat()
      .filter(
        (request) => request.submittedAt !== null && (status === null || request.status === status),
      )
      .map(cloneRequest);
    return { status: 'ok', requests };
  }

  public async review(
    reviewerUserId: string,
    requestId: string,
    action: TrainerVerificationReviewAction,
    reason: string | null,
    now: Date,
  ): Promise<TrainerVerificationReviewResult> {
    if (!this.reviewers.has(reviewerUserId)) return { status: 'not_reviewer' };
    const ownerEntry = [...this.requests.entries()].find(([, requests]) =>
      requests.some((request) => request.id === requestId),
    );
    if (ownerEntry === undefined) return { status: 'request_not_found' };
    const [ownerId, requests] = ownerEntry;
    if (ownerId === reviewerUserId) return { status: 'self_review' };
    const index = requests.findIndex((request) => request.id === requestId);
    const request = requests[index];
    if (request === undefined) return { status: 'request_not_found' };
    if (request.submittedAt === null) return { status: 'not_submitted' };
    if (action === 'approve' && request.status === 'approved') {
      return { status: 'ok', request: cloneRequest(request) };
    }
    if (request.status !== 'pending') return { status: 'invalid_state' };
    if (action === 'approve' && !this.applicantEmailVerified) {
      return { status: 'email_not_verified' };
    }
    const status =
      action === 'approve'
        ? 'approved'
        : action === 'request_info'
          ? 'needs_more_info'
          : 'rejected';
    const reviewed: TrainerVerificationRequestSnapshot = {
      ...request,
      status,
      reviewedAt: new Date(now),
      reviewerUserId,
      reviewReason: reason,
      updatedAt: new Date(now),
    };
    requests[index] = reviewed;
    return { status: 'ok', request: cloneRequest(reviewed) };
  }

  public async grantReviewer(userId: string): Promise<ReviewerMutationResult> {
    if (!this.requestedRoles.has(userId)) return 'user_not_found';
    this.reviewers.add(userId);
    return 'updated';
  }

  public async revokeReviewer(userId: string): Promise<ReviewerMutationResult> {
    return this.reviewers.delete(userId) ? 'updated' : 'user_not_found';
  }

  public grantApplicantReviewAuthority(): void {
    this.reviewers.add(APPLICANT_ID);
  }

  public setApplicantEmailVerified(value: boolean): void {
    this.applicantEmailVerified = value;
  }

  public setApplicantActiveTrainerProfile(): void {
    this.activeTrainerProfiles.add(APPLICANT_ID);
  }

  private applicationRequest(
    userId: string,
    input: TrainerVerificationApplicationInputRecord,
    now: Date,
    existingId?: string,
  ): TrainerVerificationRequestSnapshot {
    this.requestSequence += 1;
    return {
      id: existingId ?? `00000000-0000-4000-8001-${String(this.requestSequence).padStart(12, '0')}`,
      userId,
      status: 'pending',
      displayName: input.displayName,
      specialization: input.specialization,
      experienceYears: input.experienceYears,
      bio: input.bio,
      city: input.city,
      timezone: input.timezone,
      submittedAt: new Date(now),
      reviewedAt: null,
      reviewerUserId: null,
      reviewReason: null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      materials: input.materials.map((material, index) => ({
        id: `00000000-0000-4000-8002-${String(index + 1).padStart(12, '0')}`,
        ...material,
        createdAt: new Date(now),
      })),
    };
  }
}

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

const startHarness = async (): Promise<{
  readonly harness: TestHarness;
  readonly repository: InMemoryTrainerVerificationRepository;
}> => {
  const repository = new InMemoryTrainerVerificationRepository();
  const clock = new MutableClock(new Date());
  const accessTokens = new HmacJwtAccessTokenService(
    'trainer-verification-test-secret-with-more-than-32-characters',
    'kinetra-trainer-verification-test',
    'kinetra-trainer-verification-pwa-test',
    900,
  );
  const runtime: TrainerVerificationRuntime = {
    service: new TrainerVerificationService(repository, clock),
    authMiddleware: createAuthMiddleware(accessTokens),
  };
  const server = createServer(createApp({ trainerVerificationRuntime: runtime }));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No test TCP address.');
  const tokenFor = async (userId: string): Promise<string> =>
    (await accessTokens.issue(userId, `00000000-0000-4000-9000-${userId.slice(-12)}`, clock.now()))
      .token;
  return {
    repository,
    harness: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      applicantToken: await tokenFor(APPLICANT_ID),
      reviewerToken: await tokenFor(REVIEWER_ID),
      outsiderToken: await tokenFor(OUTSIDER_ID),
      traineeToken: await tokenFor(TRAINEE_ID),
      close: () => closeServer(server),
    },
  };
};

const requestJson = async (
  harness: TestHarness,
  path: string,
  options: {
    readonly method?: 'GET' | 'POST' | 'PATCH';
    readonly token?: string | null;
    readonly body?: unknown;
  } = {},
): Promise<ApiResult> => {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.token !== null)
    headers.authorization = `Bearer ${options.token ?? harness.applicantToken}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
};

const validApplication = {
  display_name: 'Trainer Applicant',
  specialization: 'Mobility and strength',
  experience_years: 7,
  bio: 'Professional trainer biography long enough for strict validation.',
  city: 'Moscow',
  timezone: 'Europe/Moscow',
  materials: [
    {
      kind: 'professional_profile',
      url: 'https://example.com/trainer/profile',
      title: 'Professional profile',
      issued_at: '2020-01-10',
    },
  ],
} as const;

test('trainer verification HTTP contract is authenticated, strict and role-gated', async () => {
  const { harness } = await startHarness();

  try {
    const unauthenticated = await requestJson(harness, '/api/v1/trainer-verification/me', {
      token: null,
    });
    assert.equal(unauthenticated.status, 401);

    const initial = await requestJson(harness, '/api/v1/trainer-verification/me');
    assert.equal(initial.status, 200);
    assert.equal(asObject(initial.body).requested_role, 'trainer');
    assert.equal(asObject(initial.body).trainer_verification_state, 'not_started');

    const trainee = await requestJson(harness, '/api/v1/trainer-verification', {
      method: 'POST',
      token: harness.traineeToken,
      body: validApplication,
    });
    assert.equal(trainee.status, 409);
    assert.equal(errorCode(trainee.body), 'TRAINER_ROLE_NOT_REQUESTED');

    for (const invalidBody of [
      { ...validApplication, authority: 'admin' },
      {
        ...validApplication,
        materials: [{ ...validApplication.materials[0], url: 'http://example.com/profile' }],
      },
      { ...validApplication, materials: [] },
      { ...validApplication, timezone: 'Invalid/Timezone' },
    ]) {
      const invalid = await requestJson(harness, '/api/v1/trainer-verification', {
        method: 'POST',
        body: invalidBody,
      });
      assert.equal(invalid.status, 400);
      assert.equal(errorCode(invalid.body), 'INVALID_TRAINER_APPLICATION');
    }

    const submitted = await requestJson(harness, '/api/v1/trainer-verification', {
      method: 'POST',
      body: validApplication,
    });
    assert.equal(submitted.status, 201);
    assert.equal(asObject(submitted.body).trainer_verification_state, 'pending');
    const request = asObject(asObject(submitted.body).request);
    assert.equal(request.status, 'pending');
    assert.equal(
      asObject((request.materials as unknown[])[0]).url,
      'https://example.com/trainer/profile',
    );

    const duplicate = await requestJson(harness, '/api/v1/trainer-verification', {
      method: 'POST',
      body: validApplication,
    });
    assert.equal(duplicate.status, 409);
    assert.equal(errorCode(duplicate.body), 'TRAINER_APPLICATION_STATE_CONFLICT');

    const malformedWithdraw = await requestJson(
      harness,
      '/api/v1/trainer-verification/me/withdraw',
      {
        method: 'POST',
        body: { reason: 'not accepted' },
      },
    );
    assert.equal(malformedWithdraw.status, 400);
    assert.equal(errorCode(malformedWithdraw.body), 'INVALID_REQUEST_BODY');
  } finally {
    await harness.close();
  }
});

test('legacy active trainer is approved without fabricated request history', async () => {
  const { harness, repository } = await startHarness();
  repository.setApplicantActiveTrainerProfile();

  try {
    const response = await requestJson(harness, '/api/v1/trainer-verification/me');
    assert.equal(response.status, 200);
    assert.equal(asObject(response.body).trainer_verification_state, 'approved');
    assert.equal(asObject(response.body).request, null);
  } finally {
    await harness.close();
  }
});

test('review transitions require current reviewer authority and approval is idempotent', async () => {
  const { harness, repository } = await startHarness();

  try {
    const submitted = await requestJson(harness, '/api/v1/trainer-verification', {
      method: 'POST',
      body: validApplication,
    });
    const requestId = String(asObject(asObject(submitted.body).request).id);

    const outsiderList = await requestJson(harness, '/api/v1/admin/trainer-verification', {
      token: harness.outsiderToken,
    });
    assert.equal(outsiderList.status, 403);
    assert.equal(errorCode(outsiderList.body), 'REVIEWER_ACCESS_REQUIRED');

    const invalidFilter = await requestJson(
      harness,
      '/api/v1/admin/trainer-verification?status=unknown',
      { token: harness.reviewerToken },
    );
    assert.equal(invalidFilter.status, 400);
    assert.equal(errorCode(invalidFilter.body), 'INVALID_STATUS_FILTER');

    repository.grantApplicantReviewAuthority();
    const selfApproval = await requestJson(
      harness,
      `/api/v1/admin/trainer-verification/${requestId}/approve`,
      { method: 'POST', body: {}, token: harness.applicantToken },
    );
    assert.equal(selfApproval.status, 403);
    assert.equal(errorCode(selfApproval.body), 'SELF_REVIEW_FORBIDDEN');

    const missingReason = await requestJson(
      harness,
      `/api/v1/admin/trainer-verification/${requestId}/request-info`,
      { method: 'POST', body: {}, token: harness.reviewerToken },
    );
    assert.equal(missingReason.status, 400);
    assert.equal(errorCode(missingReason.body), 'INVALID_REVIEW');

    const requestedInfo = await requestJson(
      harness,
      `/api/v1/admin/trainer-verification/${requestId}/request-info`,
      {
        method: 'POST',
        body: { reason: 'Add a current certificate.' },
        token: harness.reviewerToken,
      },
    );
    assert.equal(requestedInfo.status, 200);
    assert.equal(asObject(requestedInfo.body).status, 'needs_more_info');

    const resubmitted = await requestJson(harness, '/api/v1/trainer-verification/me', {
      method: 'PATCH',
      body: {
        ...validApplication,
        materials: [
          ...validApplication.materials,
          {
            kind: 'certificate',
            url: 'https://example.com/trainer/certificate',
            title: 'Current certificate',
            issued_at: '2026-01-01',
          },
        ],
      },
    });
    assert.equal(resubmitted.status, 200);
    assert.equal(asObject(resubmitted.body).trainer_verification_state, 'pending');

    const approved = await requestJson(
      harness,
      `/api/v1/admin/trainer-verification/${requestId}/approve`,
      { method: 'POST', body: {}, token: harness.reviewerToken },
    );
    assert.equal(approved.status, 200);
    assert.equal(asObject(approved.body).status, 'approved');

    const repeated = await requestJson(
      harness,
      `/api/v1/admin/trainer-verification/${requestId}/approve`,
      { method: 'POST', body: {}, token: harness.reviewerToken },
    );
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.body, approved.body);
  } finally {
    await harness.close();
  }
});

test('approval maps an unverified applicant email to a fail-closed HTTP response', async () => {
  const { harness, repository } = await startHarness();

  try {
    const submitted = await requestJson(harness, '/api/v1/trainer-verification', {
      method: 'POST',
      body: validApplication,
    });
    const requestId = String(asObject(asObject(submitted.body).request).id);
    repository.setApplicantEmailVerified(false);

    const approval = await requestJson(
      harness,
      `/api/v1/admin/trainer-verification/${requestId}/approve`,
      { method: 'POST', body: {}, token: harness.reviewerToken },
    );
    assert.equal(approval.status, 403);
    assert.equal(errorCode(approval.body), 'EMAIL_NOT_VERIFIED');
  } finally {
    await harness.close();
  }
});

test('withdrawn and rejected applications can create a new request while history remains', async () => {
  const { harness } = await startHarness();

  try {
    const first = await requestJson(harness, '/api/v1/trainer-verification', {
      method: 'POST',
      body: validApplication,
    });
    const firstId = String(asObject(asObject(first.body).request).id);
    const withdrawn = await requestJson(harness, '/api/v1/trainer-verification/me/withdraw', {
      method: 'POST',
      body: {},
    });
    assert.equal(asObject(withdrawn.body).trainer_verification_state, 'withdrawn');
    const afterWithdraw = await requestJson(harness, '/api/v1/trainer-verification', {
      method: 'POST',
      body: validApplication,
    });
    const secondId = String(asObject(asObject(afterWithdraw.body).request).id);
    assert.notEqual(secondId, firstId);

    const rejected = await requestJson(
      harness,
      `/api/v1/admin/trainer-verification/${secondId}/reject`,
      {
        method: 'POST',
        body: { reason: 'Credentials could not be verified.' },
        token: harness.reviewerToken,
      },
    );
    assert.equal(asObject(rejected.body).status, 'rejected');
    const afterReject = await requestJson(harness, '/api/v1/trainer-verification', {
      method: 'POST',
      body: validApplication,
    });
    assert.notEqual(String(asObject(asObject(afterReject.body).request).id), secondId);
  } finally {
    await harness.close();
  }
});
