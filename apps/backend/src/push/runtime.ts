import type { RequestHandler } from 'express';

import { createAuthMiddleware } from '../auth/middleware.js';
import { SystemClock, type Clock } from '../auth/service.js';
import { HmacJwtAccessTokenService } from '../auth/tokens.js';
import { createFixedWindowRateLimiter } from '../auth/rate-limit.js';
import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import { PostgresSubscriptionAccessChecker } from '../payments/subscription-access.js';
import { PostgresProgramRepository } from '../program/postgres-program.repository.js';
import { PostgresProgressRepository } from '../progress/postgres-progress.repository.js';
import { PostgresPushRepository } from './postgres-push.repository.js';
import { NotificationSchedulerService } from './scheduler-service.js';
import { PushService } from './service.js';
import { UnavailablePushSender, WebPushSender, type PushSender } from './webpush-sender.js';

export interface PushRuntime {
  readonly service: PushService;
  readonly schedulerService: NotificationSchedulerService;
  readonly authMiddleware: RequestHandler;
  readonly mutationRateLimiter: RequestHandler;
  readonly clock: Clock;
  readonly configured: boolean;
}

export interface CreatePushRuntimeOptions {
  readonly sender?: PushSender;
  readonly clock?: Clock;
}

export const createProductionPushRuntime = (
  options: CreatePushRuntimeOptions = {},
): PushRuntime => {
  const verifier = new HmacJwtAccessTokenService(
    env.auth.jwtAccessSecret,
    env.auth.jwtIssuer,
    env.auth.jwtAudience,
    env.auth.jwtAccessTtlSeconds,
  );
  const repository = new PostgresPushRepository(databasePool);
  const clock = options.clock ?? new SystemClock();
  const sender =
    options.sender ??
    (env.vapid === null
      ? new UnavailablePushSender()
      : new WebPushSender({
          subject: env.vapid.subject,
          publicKey: env.vapid.publicKey,
          privateKey: env.vapid.privateKey,
        }));

  return {
    service: new PushService(repository, env.vapid?.publicKey ?? null),
    schedulerService: new NotificationSchedulerService(
      repository,
      new PostgresProgramRepository(databasePool),
      new PostgresProgressRepository(databasePool),
      new PostgresSubscriptionAccessChecker(databasePool),
      sender,
      clock,
    ),
    authMiddleware: createAuthMiddleware(verifier),
    mutationRateLimiter: createFixedWindowRateLimiter({
      windowMs: 60_000,
      maximumRequests: 60,
      errorCode: 'PUSH_RATE_LIMITED',
      errorMessage: 'Too many push subscription requests. Try again later.',
    }),
    clock,
    configured: env.vapid !== null,
  };
};
