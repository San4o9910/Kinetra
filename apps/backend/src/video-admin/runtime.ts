import type { RequestHandler } from 'express';

import { createAuthMiddleware } from '../auth/middleware.js';
import { SystemClock, type Clock } from '../auth/service.js';
import { HmacJwtAccessTokenService } from '../auth/tokens.js';
import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import { PostgresVideoAdminRepository } from './postgres-video.repository.js';
import type { VideoAdminRepository } from './repository.js';
import { VideoAdminService } from './service.js';
import { S3VideoStorage, UnavailableVideoStorage, type VideoStorage } from './storage.js';
import { assertVideoVerifierAvailable } from './verifier.js';

export interface VideoAdminRuntime {
  readonly service: VideoAdminService;
  readonly repository: VideoAdminRepository;
  readonly storage: VideoStorage;
  readonly authMiddleware: RequestHandler;
}

export interface CreateVideoAdminRuntimeOptions {
  readonly repository?: VideoAdminRepository;
  readonly storage?: VideoStorage;
  readonly clock?: Clock;
}

export interface VideoCleanupRuntime {
  readonly repository: VideoAdminRepository;
  readonly storage: VideoStorage;
}

const createRepositoryAndStorage = (
  options: CreateVideoAdminRuntimeOptions,
): VideoCleanupRuntime => ({
  repository: options.repository ?? new PostgresVideoAdminRepository(databasePool),
  storage:
    options.storage ??
    (env.s3 === null
      ? new UnavailableVideoStorage()
      : new S3VideoStorage(env.s3, env.videoUploads)),
});

export const createProductionVideoCleanupRuntime = (
  options: CreateVideoAdminRuntimeOptions = {},
): VideoCleanupRuntime => createRepositoryAndStorage(options);

export const createProductionVideoAdminRuntime = (
  options: CreateVideoAdminRuntimeOptions = {},
): VideoAdminRuntime => {
  const verifier = new HmacJwtAccessTokenService(
    env.auth.jwtAccessSecret,
    env.auth.jwtIssuer,
    env.auth.jwtAudience,
    env.auth.jwtAccessTtlSeconds,
  );
  const { repository, storage } = createRepositoryAndStorage(options);
  const clock = options.clock ?? new SystemClock();
  if (env.videoUploads.enabled && !storage.available)
    throw new Error('TRAINER_VIDEO_UPLOADS_ENABLED=true requires available private S3 storage.');
  if (env.videoUploads.enabled) assertVideoVerifierAvailable(env.videoUploads.ffprobePath);
  return {
    repository,
    storage,
    service: new VideoAdminService(repository, storage, env.videoUploads, clock),
    authMiddleware: createAuthMiddleware(verifier),
  };
};
