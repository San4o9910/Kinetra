import type { ApiErrorResponse, HealthResponse } from '@kinetra/shared';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';

import { HttpError } from './auth/errors.js';
import { createAuthRouter } from './auth/router.js';
import { createProductionAuthRuntime, type AuthRuntime } from './auth/runtime.js';
import { createBaseLessonsRouter } from './base-lessons/router.js';
import {
  createProductionBaseLessonsRuntime,
  type BaseLessonsRuntime,
} from './base-lessons/runtime.js';
import { createChatRouter } from './chat/router.js';
import { createProductionChatRuntime, type ChatRuntime } from './chat/runtime.js';
import { env } from './config/env.js';
import { createDatabaseReadinessCheck, databasePool } from './db/pool.js';
import { createPaymentsRouter } from './payments/router.js';
import { createProductionPaymentsRuntime, type PaymentsRuntime } from './payments/runtime.js';
import { createProfileRouter } from './profile/router.js';
import { createProductionProfileRuntime, type ProfileRuntime } from './profile/runtime.js';
import { createProgramRouter } from './program/router.js';
import { createProductionProgramRuntime, type ProgramRuntime } from './program/runtime.js';
import { createProgressRouter } from './progress/router.js';
import { createProductionProgressRuntime, type ProgressRuntime } from './progress/runtime.js';
import { createPushRouter } from './push/router.js';
import { createProductionPushRuntime, type PushRuntime } from './push/runtime.js';
import { createSettingsRouter } from './settings/router.js';
import { createProductionSettingsRuntime, type SettingsRuntime } from './settings/runtime.js';
import {
  createTrainerVerificationAdminRouter,
  createTrainerVerificationRouter,
} from './trainer-verification/router.js';
import {
  createProductionTrainerVerificationRuntime,
  type TrainerVerificationRuntime,
} from './trainer-verification/runtime.js';
import { createVideoAdminRouter } from './video-admin/router.js';
import {
  createProductionVideoAdminRuntime,
  type VideoAdminRuntime,
} from './video-admin/runtime.js';

export interface CreateAppOptions {
  readonly readinessCheck?: () => Promise<boolean>;
  readonly isDraining?: () => boolean;
  readonly authRuntime?: AuthRuntime;
  readonly profileRuntime?: ProfileRuntime;
  readonly baseLessonsRuntime?: BaseLessonsRuntime;
  readonly chatRuntime?: ChatRuntime;
  readonly programRuntime?: ProgramRuntime;
  readonly progressRuntime?: ProgressRuntime;
  readonly pushRuntime?: PushRuntime;
  readonly settingsRuntime?: SettingsRuntime;
  readonly paymentsRuntime?: PaymentsRuntime;
  readonly videoAdminRuntime?: VideoAdminRuntime;
  readonly trainerVerificationRuntime?: TrainerVerificationRuntime;
}

const requestIdFrom = (response: Response): string =>
  typeof response.locals.requestId === 'string' ? response.locals.requestId : randomUUID();

const isMalformedJsonError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'type' in error &&
  (error as { type?: unknown }).type === 'entity.parse.failed';

const safeUnhandledErrorCode = (error: unknown): string => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'UNCLASSIFIED';
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'UNCLASSIFIED';
};

export const createApp = (options: CreateAppOptions = {}) => {
  const app = express();
  const readinessCheck =
    options.readinessCheck ??
    createDatabaseReadinessCheck(() => databasePool.query('SELECT 1'), env.readinessTimeoutMs);
  const isDraining = options.isDraining ?? (() => false);
  const authRuntime = options.authRuntime ?? createProductionAuthRuntime();
  const profileRuntime = options.profileRuntime ?? createProductionProfileRuntime();
  const baseLessonsRuntime = options.baseLessonsRuntime ?? createProductionBaseLessonsRuntime();
  const chatRuntime =
    options.chatRuntime ??
    createProductionChatRuntime({ accessTokenVerifier: authRuntime.accessTokenVerifier });
  const programRuntime = options.programRuntime ?? createProductionProgramRuntime();
  const progressRuntime = options.progressRuntime ?? createProductionProgressRuntime();
  const pushRuntime = options.pushRuntime ?? createProductionPushRuntime();
  const settingsRuntime = options.settingsRuntime ?? createProductionSettingsRuntime();
  const paymentsRuntime = options.paymentsRuntime ?? createProductionPaymentsRuntime();
  const videoAdminRuntime = options.videoAdminRuntime ?? createProductionVideoAdminRuntime();
  const trainerVerificationRuntime =
    options.trainerVerificationRuntime ?? createProductionTrainerVerificationRuntime();

  app.disable('x-powered-by');

  if (env.trustProxyHops > 0) {
    app.set('trust proxy', env.trustProxyHops);
  }
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = request.headers['x-request-id'];
    response.locals.requestId =
      typeof requestId === 'string' && requestId.length <= 128 ? requestId : randomUUID();
    response.setHeader('X-Request-Id', requestIdFrom(response));
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (env.nodeEnv === 'production')
      response.setHeader('Strict-Transport-Security', 'max-age=86400');
    next();
  });
  app.use(
    cors({
      origin: [...env.corsOrigins],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_request: Request, response: Response<HealthResponse>) => {
    response.status(200).json({
      status: 'ok',
      service: 'kinetra-backend',
      version: '0.4.0',
      timestamp: new Date().toISOString(),
    });
  });

  // Private infrastructure endpoint. This checks connectivity, not migration version.
  app.get('/ready', async (_request: Request, response: Response) => {
    if (isDraining()) {
      response.status(503).json({ status: 'not_ready' });
      return;
    }
    const connected = await Promise.resolve()
      .then(readinessCheck)
      .catch(() => false);
    const ready = connected && !isDraining();
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  app.use(
    '/api/v1/auth',
    createAuthRouter({
      service: authRuntime.service,
      accessTokenVerifier: authRuntime.accessTokenVerifier,
      refreshCookie: authRuntime.refreshCookie,
      passwordResetRateLimiter: authRuntime.passwordResetRateLimiter,
    }),
  );

  app.use('/api/v1/me', createProfileRouter(profileRuntime));
  app.use('/api/v1/base-lessons', createBaseLessonsRouter(baseLessonsRuntime));
  app.use('/api/v1/chat', createChatRouter(chatRuntime));
  app.use('/api/v1/program', createProgramRouter(programRuntime));
  app.use('/api/v1/progress', createProgressRouter(progressRuntime));
  app.use('/api/v1/push', createPushRouter(pushRuntime));
  app.use(
    '/api/v1/settings',
    createSettingsRouter({
      ...settingsRuntime,
      refreshCookie: authRuntime.refreshCookie,
    }),
  );
  app.use('/api/v1/payments', createPaymentsRouter(paymentsRuntime));
  app.use('/api/v1/trainer/videos', createVideoAdminRouter(videoAdminRuntime));
  app.use(
    '/api/v1/trainer-verification',
    createTrainerVerificationRouter(trainerVerificationRuntime),
  );
  app.use(
    '/api/v1/admin/trainer-verification',
    createTrainerVerificationAdminRouter(trainerVerificationRuntime),
  );

  app.use((request: Request, response: Response<ApiErrorResponse>) => {
    response.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.path} was not found.`,
        requestId: requestIdFrom(response),
      },
    });
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response<ApiErrorResponse>,
      _next: NextFunction,
    ) => {
      const requestId = requestIdFrom(response);
      response.setHeader('Cache-Control', 'no-store');

      if (error instanceof HttpError) {
        response.status(error.statusCode).json({
          error: {
            code: error.code,
            message: error.message,
            requestId,
          },
        });
        return;
      }

      if (isMalformedJsonError(error)) {
        response.status(400).json({
          error: {
            code: 'INVALID_JSON',
            message: 'Request body contains invalid JSON.',
            requestId,
          },
        });
        return;
      }

      // Never pass the raw error to the logger here. PostgreSQL errors can carry
      // statement details and complete row values, including private chat text.
      console.error('Unhandled request error.', {
        requestId,
        code: safeUnhandledErrorCode(error),
      });
      response.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unexpected server error.',
          requestId,
        },
      });
    },
  );

  return app;
};
