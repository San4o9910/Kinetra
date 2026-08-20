import type { RequestHandler } from 'express';

import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import type { RefreshCookieConfig } from './cookies.js';
import {
  ConsoleAuthTokenDelivery,
  DisabledAuthTokenDelivery,
  type AuthTokenDelivery,
} from './delivery.js';
import { BcryptPasswordHasher } from './password.js';
import { PostgresAuthRepository } from './postgres-auth.repository.js';
import { createFixedWindowRateLimiter } from './rate-limit.js';
import { AuthService, SystemClock } from './service.js';
import { HmacJwtAccessTokenService, OpaqueTokenService } from './tokens.js';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const MINUTE_IN_MILLISECONDS = 60 * 1000;

export interface AuthRuntime {
  readonly service: AuthService;
  readonly refreshCookie: RefreshCookieConfig;
  readonly passwordResetRateLimiter: RequestHandler;
}

const createTokenDelivery = (): AuthTokenDelivery =>
  env.auth.tokenDeliveryMode === 'console'
    ? new ConsoleAuthTokenDelivery()
    : new DisabledAuthTokenDelivery();

export const createProductionAuthRuntime = (): AuthRuntime => {
  const refreshTtlMs = env.auth.refreshTtlDays * DAY_IN_MILLISECONDS;
  const repository = new PostgresAuthRepository(databasePool);
  const service = new AuthService({
    repository,
    passwordHasher: new BcryptPasswordHasher(env.auth.bcryptCost),
    opaqueTokens: new OpaqueTokenService(),
    accessTokens: new HmacJwtAccessTokenService(
      env.auth.jwtAccessSecret,
      env.auth.jwtIssuer,
      env.auth.jwtAudience,
      env.auth.jwtAccessTtlSeconds,
    ),
    tokenDelivery: createTokenDelivery(),
    clock: new SystemClock(),
    config: {
      phoneLoginEnabled: env.auth.phoneLoginEnabled,
      phoneOnlyRegistrationEnabled: env.auth.phoneOnlyRegistrationEnabled,
      emailVerificationRequired: env.auth.emailVerificationRequired,
      passwordMinimumLength: env.auth.passwordMinimumLength,
      refreshTtlMs,
      passwordResetTtlMs: env.auth.passwordResetTtlMinutes * MINUTE_IN_MILLISECONDS,
      emailVerificationTtlMs:
        env.auth.emailVerificationTtlMinutes * MINUTE_IN_MILLISECONDS,
    },
  });

  return {
    service,
    refreshCookie: {
      name: env.auth.refreshCookieName,
      secure: env.auth.refreshCookieSecure,
      sameSite: env.auth.refreshCookieSameSite,
      maxAgeMs: refreshTtlMs,
    },
    passwordResetRateLimiter: createFixedWindowRateLimiter({
      windowMs: env.auth.passwordResetRateLimitWindowMs,
      maximumRequests: env.auth.passwordResetRateLimitMax,
    }),
  };
};
