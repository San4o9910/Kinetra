import type { ApiErrorResponse, WeekResponse } from '@kinetra/shared';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import type { ProgramService } from './service.js';

export interface ProgramRouterDependencies {
  readonly service: ProgramService;
  readonly authMiddleware: RequestHandler;
}

const disableCaching = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

export const createProgramRouter = ({
  service,
  authMiddleware,
}: ProgramRouterDependencies): Router => {
  const router = Router();

  router.use(disableCaching);
  router.use(authMiddleware);

  router.get(
    '/current-week',
    (request: Request, response: Response<WeekResponse>, next: NextFunction): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .getCurrentWeek(userId)
        .then((week) => response.status(200).json(week))
        .catch(next);
    },
  );

  router.get(
    '/weeks/:weekNumber',
    (
      request: Request<{ weekNumber: string }>,
      response: Response<WeekResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .getWeek(userId, request.params.weekNumber)
        .then((week) => response.status(200).json(week))
        .catch(next);
    },
  );

  router.put(
    '/complete-workout',
    (
      request: Request,
      response: Response<WeekResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .completeWorkout(userId, request.body)
        .then((week) => response.status(200).json(week))
        .catch(next);
    },
  );

  return router;
};
