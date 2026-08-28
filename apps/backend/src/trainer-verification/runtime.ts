import type { RequestHandler } from 'express';

import { createAuthMiddleware } from '../auth/middleware.js';
import { SystemClock } from '../auth/service.js';
import { HmacJwtAccessTokenService } from '../auth/tokens.js';
import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import { PostgresTrainerVerificationRepository } from './postgres-trainer-verification.repository.js';
import { TrainerVerificationService } from './service.js';

export interface TrainerVerificationRuntime {
  readonly service: TrainerVerificationService;
  readonly authMiddleware: RequestHandler;
}

export const createProductionTrainerVerificationRuntime = (): TrainerVerificationRuntime => {
  const verifier = new HmacJwtAccessTokenService(
    env.auth.jwtAccessSecret,
    env.auth.jwtIssuer,
    env.auth.jwtAudience,
    env.auth.jwtAccessTtlSeconds,
  );

  return {
    service: new TrainerVerificationService(
      new PostgresTrainerVerificationRepository(databasePool),
      new SystemClock(),
    ),
    authMiddleware: createAuthMiddleware(verifier),
  };
};
