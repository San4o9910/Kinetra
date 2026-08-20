import type { ApiErrorResponse, MeResponse } from '@kinetra/shared';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import type { ProfileService } from './service.js';

export interface ProfileRouterDependencies {
  readonly service: ProfileService;
  readonly authMiddleware: RequestHandler;
}

const disableCaching = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

export const createProfileRouter = ({
  service,
  authMiddleware,
}: ProfileRouterDependencies): Router => {
  const router = Router();

  router.use(disableCaching);
  router.use(authMiddleware);

  router.get(
    '/',
    (request: Request, response: Response<MeResponse>, next: NextFunction): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .getProfile(userId)
        .then((profile) => response.status(200).json(profile))
        .catch(next);
    },
  );

  router.put(
    '/survey',
    (
      request: Request,
      response: Response<MeResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .saveSurvey(userId, request.body)
        .then((profile) => response.status(200).json(profile))
        .catch(next);
    },
  );

  return router;
};
