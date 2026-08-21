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
import { env } from './config/env.js';
import { createProfileRouter } from './profile/router.js';
import { createProductionProfileRuntime, type ProfileRuntime } from './profile/runtime.js';
import { createProgramRouter } from './program/router.js';
import { createProductionProgramRuntime, type ProgramRuntime } from './program/runtime.js';
import { createProgressRouter } from './progress/router.js';
import { createProductionProgressRuntime, type ProgressRuntime } from './progress/runtime.js';
import { createSettingsRouter } from './settings/router.js';
import { createProductionSettingsRuntime, type SettingsRuntime } from './settings/runtime.js';

export interface CreateAppOptions {
  readonly authRuntime?: AuthRuntime;
  readonly profileRuntime?: ProfileRuntime;
  readonly baseLessonsRuntime?: BaseLessonsRuntime;
  readonly programRuntime?: ProgramRuntime;
  readonly progressRuntime?: ProgressRuntime;
  readonly settingsRuntime?: SettingsRuntime;
}

const requestIdFrom = (response: Response): string =>
  typeof response.locals.requestId === 'string' ? response.locals.requestId : randomUUID();

const isMalformedJsonError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'type' in error &&
  (error as { type?: unknown }).type === 'entity.parse.failed';

export const createApp = (options: CreateAppOptions = {}) => {
  const app = express();
  const authRuntime = options.authRuntime ?? createProductionAuthRuntime();
  const profileRuntime = options.profileRuntime ?? createProductionProfileRuntime();
  const baseLessonsRuntime = options.baseLessonsRuntime ?? createProductionBaseLessonsRuntime();
  const programRuntime = options.programRuntime ?? createProductionProgramRuntime();
  const progressRuntime = options.progressRuntime ?? createProductionProgressRuntime();
  const settingsRuntime = options.settingsRuntime ?? createProductionSettingsRuntime();

  app.disable('x-powered-by');

  if (env.trustProxyHops > 0) {
    app.set('trust proxy', env.trustProxyHops);
  }
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = request.headers['x-request-id'];
    response.locals.requestId =
      typeof requestId === 'string' && requestId.length <= 128 ? requestId : randomUUID();
    response.setHeader('X-Request-Id', requestIdFrom(response));
    next();
  });
  app.use(
    cors({
      origin: env.corsOrigins,
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

  app.use(
    '/api/v1/auth',
    createAuthRouter({
      service: authRuntime.service,
      refreshCookie: authRuntime.refreshCookie,
      passwordResetRateLimiter: authRuntime.passwordResetRateLimiter,
    }),
  );

  app.use('/api/v1/me', createProfileRouter(profileRuntime));
  app.use('/api/v1/base-lessons', createBaseLessonsRouter(baseLessonsRuntime));
  app.use('/api/v1/program', createProgramRouter(programRuntime));
  app.use('/api/v1/progress', createProgressRouter(progressRuntime));
  app.use(
    '/api/v1/settings',
    createSettingsRouter({
      ...settingsRuntime,
      refreshCookie: authRuntime.refreshCookie,
    }),
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

      console.error(`[${requestId}] Unhandled request error`, error);
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
