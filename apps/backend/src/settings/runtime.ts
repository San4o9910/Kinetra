import type { RequestHandler } from 'express';

import { createAuthMiddleware } from '../auth/middleware.js';
import { SystemClock } from '../auth/service.js';
import { HmacJwtAccessTokenService } from '../auth/tokens.js';
import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import { PostgresSettingsRepository } from './postgres-settings.repository.js';
import { SettingsService } from './service.js';
import { PostgresFreeBetaAccessChecker } from '../program/free-beta-access.js';

export interface SettingsRuntime {
  readonly service: SettingsService;
  readonly authMiddleware: RequestHandler;
}

export const createProductionSettingsRuntime = (): SettingsRuntime => {
  const verifier = new HmacJwtAccessTokenService(
    env.auth.jwtAccessSecret,
    env.auth.jwtIssuer,
    env.auth.jwtAudience,
    env.auth.jwtAccessTtlSeconds,
  );

  return {
    service: new SettingsService(
      new PostgresSettingsRepository(databasePool),
      new SystemClock(),
      env.paymentsEnabled,
      new PostgresFreeBetaAccessChecker(databasePool, env.freeBetaEnabled),
    ),
    authMiddleware: createAuthMiddleware(verifier),
  };
};
