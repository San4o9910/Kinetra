import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { HttpError } from '../src/auth/errors.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import type { VideoUploadsEnvironment } from '../src/config/env.js';
import type { VideoAdminRepository } from '../src/video-admin/repository.js';
import { createVideoAdminRouter } from '../src/video-admin/router.js';
import { VideoAdminService } from '../src/video-admin/service.js';
import type { VideoStorage } from '../src/video-admin/storage.js';
import { MutableClock } from './support/test-clock.js';

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((caught) => (caught === undefined ? resolve() : reject(caught)));
  });
};

test('T14 HTTP API authenticates, rechecks video permission and returns private strict responses', async () => {
  const authorizedId = randomUUID();
  const forbiddenId = randomUUID();
  const tokenService = new HmacJwtAccessTokenService(
    't14-http-test-access-secret-longer-than-thirty-two-bytes',
    'kinetra-t14-test',
    'kinetra-t14-pwa-test',
    900,
  );
  const repository = {
    getAuthority: async (userId: string) =>
      userId === authorizedId ? { userId, displayName: 'Тренер' } : null,
    listProgram: async () => ({
      summary: { total: 84, available: 0, processing: 0, failed: 0 },
      weeks: [],
    }),
  } as unknown as VideoAdminRepository;
  const storage = { available: false } as VideoStorage;
  const configuration: Readonly<VideoUploadsEnvironment> = {
    enabled: true,
    maxBytes: 2_147_483_648,
    partSizeBytes: 16_777_216,
    partUrlTtlSeconds: 900,
    sessionTtlSeconds: 21_600,
    maxActivePerTrainer: 3,
    ffprobePath: 'ffprobe',
    verifyLeaseSeconds: 300,
    verifyDeadlineSeconds: 900,
    verifyMaxAttempts: 8,
    workerMaxStaleSeconds: 300,
    deleteGraceSeconds: 86_400,
    serverSideEncryption: 'AES256',
    kmsKeyId: null,
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/trainer/videos',
    createVideoAdminRouter({
      service: new VideoAdminService(
        repository,
        storage,
        configuration,
        new MutableClock(new Date('2026-08-24T12:00:00.000Z')),
      ),
      authMiddleware: createAuthMiddleware(tokenService),
    }),
  );
  app.use((caught: unknown, _request: Request, response: Response, _next: NextFunction): void => {
    response.setHeader('Cache-Control', 'no-store');
    if (caught instanceof HttpError) {
      response.status(caught.statusCode).json({ error: { code: caught.code } });
      return;
    }
    response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing server address.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const authorizedToken = (await tokenService.issue(authorizedId, randomUUID(), new Date())).token;
  const forbiddenToken = (await tokenService.issue(forbiddenId, randomUUID(), new Date())).token;

  try {
    const unauthenticated = await fetch(`${baseUrl}/api/v1/trainer/videos/program`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get('cache-control'), 'no-store');
    assert.equal(unauthenticated.headers.get('pragma'), 'no-cache');
    assert.equal(unauthenticated.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(unauthenticated.headers.get('x-content-type-options'), 'nosniff');

    const forbidden = await fetch(`${baseUrl}/api/v1/trainer/videos/program`, {
      headers: { authorization: `Bearer ${forbiddenToken}` },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(
      ((await forbidden.json()) as { error: { code: string } }).error.code,
      'VIDEO_ADMIN_FORBIDDEN',
    );

    const authorized = await fetch(`${baseUrl}/api/v1/trainer/videos/program`, {
      headers: { authorization: `Bearer ${authorizedToken}` },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), {
      summary: { total: 84, available: 0, processing: 0, failed: 0 },
      weeks: [],
    });

    const strict = await fetch(`${baseUrl}/api/v1/trainer/videos/uploads`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${authorizedToken}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        week_number: 1,
        day_of_week: 1,
        mime_type: 'video/mp4',
        size_bytes: 1,
        user_id: forbiddenId,
      }),
    });
    assert.equal(strict.status, 400);
    assert.equal(
      ((await strict.json()) as { error: { code: string } }).error.code,
      'VIDEO_UPLOAD_INVALID_REQUEST',
    );
    console.log('KINETRA_T14_BACKEND_E2E=PASS');
  } finally {
    await closeServer(server);
  }
});
