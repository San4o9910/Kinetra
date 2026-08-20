import type { RequestHandler } from 'express';

import { createAuthMiddleware } from '../auth/middleware.js';
import { HmacJwtAccessTokenService } from '../auth/tokens.js';
import { S3ObjectUrlSigner, UnavailableObjectUrlSigner } from '../base-lessons/storage.js';
import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import { PostgresProgramRepository } from './postgres-program.repository.js';
import { ProgramService } from './service.js';

export interface ProgramRuntime {
  readonly service: ProgramService;
  readonly authMiddleware: RequestHandler;
}

export const createProductionProgramRuntime = (): ProgramRuntime => {
  const verifier = new HmacJwtAccessTokenService(
    env.auth.jwtAccessSecret,
    env.auth.jwtIssuer,
    env.auth.jwtAudience,
    env.auth.jwtAccessTtlSeconds,
  );
  const objectUrlSigner =
    env.s3 === null ? new UnavailableObjectUrlSigner() : new S3ObjectUrlSigner(env.s3);

  return {
    service: new ProgramService(new PostgresProgramRepository(databasePool), objectUrlSigner),
    authMiddleware: createAuthMiddleware(verifier),
  };
};
