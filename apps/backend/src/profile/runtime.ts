import type { RequestHandler } from 'express';

import { createAuthMiddleware } from '../auth/middleware.js';
import { HmacJwtAccessTokenService } from '../auth/tokens.js';
import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import { PostgresProfileRepository } from './postgres-profile.repository.js';
import { ProfileService } from './service.js';

export interface ProfileRuntime {
  readonly service: ProfileService;
  readonly authMiddleware: RequestHandler;
}

export const createProductionProfileRuntime = (): ProfileRuntime => {
  const verifier = new HmacJwtAccessTokenService(
    env.auth.jwtAccessSecret,
    env.auth.jwtIssuer,
    env.auth.jwtAudience,
    env.auth.jwtAccessTtlSeconds,
  );

  return {
    service: new ProfileService(new PostgresProfileRepository(databasePool)),
    authMiddleware: createAuthMiddleware(verifier),
  };
};
