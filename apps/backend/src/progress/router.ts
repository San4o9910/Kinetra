import type {
  ApiErrorResponse,
  GoalResponse,
  MetricsResponse,
  ProgressResponse,
} from '@kinetra/shared';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import type { ProgressService } from './service.js';

export interface ProgressRouterDependencies {
  readonly service: ProgressService;
  readonly authMiddleware: RequestHandler;
}

const disableCaching = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

export const createProgressRouter = ({
  service,
  authMiddleware,
}: ProgressRouterDependencies): Router => {
  const router = Router();

  router.use(disableCaching);
  router.use(authMiddleware);

  router.get(
    '/',
    (request: Request, response: Response<ProgressResponse>, next: NextFunction): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .getProgress(userId)
        .then((progress) => response.status(200).json(progress))
        .catch(next);
    },
  );

  router.put(
    '/weekly-metrics',
    (
      request: Request,
      response: Response<MetricsResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .submitWeeklyMetrics(userId, request.body)
        .then((metrics) => response.status(200).json(metrics))
        .catch(next);
    },
  );

  router.put(
    '/goal',
    (
      request: Request,
      response: Response<GoalResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .updateGoal(userId, request.body)
        .then((goal) => response.status(200).json(goal))
        .catch(next);
    },
  );

  return router;
};
