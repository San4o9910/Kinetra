import type {
  ApiErrorResponse,
  BaseLessonsResponse,
  LessonProgressResponse,
  MeResponse,
} from '@kinetra/shared';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import type { BaseLessonsService } from './service.js';

export interface BaseLessonsRouterDependencies {
  readonly service: BaseLessonsService;
  readonly authMiddleware: RequestHandler;
}

const disableCaching = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

export const createBaseLessonsRouter = ({
  service,
  authMiddleware,
}: BaseLessonsRouterDependencies): Router => {
  const router = Router();

  router.use(disableCaching);
  router.use(authMiddleware);

  router.get(
    '/',
    (request: Request, response: Response<BaseLessonsResponse>, next: NextFunction): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .getLessons(userId)
        .then((lessons) => response.status(200).json(lessons))
        .catch(next);
    },
  );

  router.put(
    '/complete-program',
    (
      request: Request,
      response: Response<MeResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .completeProgram(userId)
        .then((profile) => response.status(200).json(profile))
        .catch(next);
    },
  );

  router.put(
    '/:lessonId/progress',
    (
      request: Request<{ lessonId: string }>,
      response: Response<LessonProgressResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .updateProgress(userId, request.params.lessonId, request.body)
        .then((progress) => response.status(200).json(progress))
        .catch(next);
    },
  );

  return router;
};
