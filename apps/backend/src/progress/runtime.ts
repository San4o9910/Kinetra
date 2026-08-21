import type { RequestHandler } from 'express';

import { createAuthMiddleware } from '../auth/middleware.js';
import { HmacJwtAccessTokenService } from '../auth/tokens.js';
import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import { PostgresProgramRepository } from '../program/postgres-program.repository.js';
import { PostgresProgressRepository } from './postgres-progress.repository.js';
import { ProgressService } from './service.js';

export interface ProgressRuntime {
  readonly service: ProgressService;
  readonly authMiddleware: RequestHandler;
}

export const createProductionProgressRuntime = (): ProgressRuntime => {
  const verifier = new HmacJwtAccessTokenService(
    env.auth.jwtAccessSecret,
    env.auth.jwtIssuer,
    env.auth.jwtAudience,
    env.auth.jwtAccessTtlSeconds,
  );

  return {
    service: new ProgressService(
      new PostgresProgressRepository(databasePool),
      new PostgresProgramRepository(databasePool),
    ),
    authMiddleware: createAuthMiddleware(verifier),
  };
};
