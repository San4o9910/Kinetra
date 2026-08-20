import type { RequestHandler } from 'express';

import { createAuthMiddleware } from '../auth/middleware.js';
import { HmacJwtAccessTokenService } from '../auth/tokens.js';
import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import { PostgresProfileRepository } from '../profile/postgres-profile.repository.js';
import { ProfileService } from '../profile/service.js';
import { PostgresBaseLessonsRepository } from './postgres-base-lessons.repository.js';
import { BaseLessonsService } from './service.js';
import { S3ObjectUrlSigner, UnavailableObjectUrlSigner } from './storage.js';

export interface BaseLessonsRuntime {
  readonly service: BaseLessonsService;
  readonly authMiddleware: RequestHandler;
}

export const createProductionBaseLessonsRuntime = (): BaseLessonsRuntime => {
  const verifier = new HmacJwtAccessTokenService(
    env.auth.jwtAccessSecret,
    env.auth.jwtIssuer,
    env.auth.jwtAudience,
    env.auth.jwtAccessTtlSeconds,
  );
  const objectUrlSigner =
    env.s3 === null ? new UnavailableObjectUrlSigner() : new S3ObjectUrlSigner(env.s3);
  const profileService = new ProfileService(new PostgresProfileRepository(databasePool));

  return {
    service: new BaseLessonsService(
      new PostgresBaseLessonsRepository(databasePool),
      objectUrlSigner,
      profileService,
    ),
    authMiddleware: createAuthMiddleware(verifier),
  };
};
