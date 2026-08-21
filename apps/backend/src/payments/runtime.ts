import type { RequestHandler } from 'express';

import { createAuthMiddleware } from '../auth/middleware.js';
import { SystemClock } from '../auth/service.js';
import { HmacJwtAccessTokenService } from '../auth/tokens.js';
import { env } from '../config/env.js';
import { databasePool } from '../db/pool.js';
import { PostgresPaymentsRepository } from './postgres-payments.repository.js';
import {
  ConsoleRenewalFailureNotifier,
  RenewalService,
  type RenewalFailureNotifier,
} from './renewal-service.js';
import { PaymentsService } from './service.js';
import {
  UnavailableYooKassaClient,
  HttpYooKassaClient,
  type YooKassaClient,
} from './yookassa-client.js';
import { YooKassaWebhookSourceVerifier, type WebhookSourceVerifier } from './webhook-source.js';

export interface PaymentsRuntime {
  readonly service: PaymentsService;
  readonly renewalService: RenewalService;
  readonly authMiddleware: RequestHandler;
  readonly webhookSourceVerifier: WebhookSourceVerifier;
}

export interface CreatePaymentsRuntimeOptions {
  readonly client?: YooKassaClient;
  readonly webhookSourceVerifier?: WebhookSourceVerifier;
  readonly renewalFailureNotifier?: RenewalFailureNotifier;
}

export const createProductionPaymentsRuntime = (
  options: CreatePaymentsRuntimeOptions = {},
): PaymentsRuntime => {
  const verifier = new HmacJwtAccessTokenService(
    env.auth.jwtAccessSecret,
    env.auth.jwtIssuer,
    env.auth.jwtAudience,
    env.auth.jwtAccessTtlSeconds,
  );
  const repository = new PostgresPaymentsRepository(databasePool);
  const clock = new SystemClock();
  const client =
    options.client ??
    (env.yookassa === null
      ? new UnavailableYooKassaClient()
      : new HttpYooKassaClient({
          shopId: env.yookassa.shopId,
          secretKey: env.yookassa.secretKey,
          requestTimeoutMs: env.yookassa.requestTimeoutMs,
        }));
  const allowedReturnUrls = env.yookassa?.returnUrls ?? ['http://localhost:5173/payment/success'];

  return {
    service: new PaymentsService(repository, client, clock, allowedReturnUrls),
    renewalService: new RenewalService(
      repository,
      client,
      clock,
      options.renewalFailureNotifier ?? new ConsoleRenewalFailureNotifier(),
    ),
    authMiddleware: createAuthMiddleware(verifier),
    webhookSourceVerifier: options.webhookSourceVerifier ?? new YooKassaWebhookSourceVerifier(),
  };
};
