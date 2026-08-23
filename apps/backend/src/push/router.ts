import type {
  ApiErrorResponse,
  PushPublicKeyResponse,
  PushSubscriptionResponse,
} from '@kinetra/shared';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import type { Clock } from '../auth/service.js';
import type { PushService } from './service.js';

export interface PushRouterDependencies {
  readonly service: PushService;
  readonly authMiddleware: RequestHandler;
  readonly mutationRateLimiter: RequestHandler;
  readonly clock: Clock;
}

const disableCaching = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  next();
};

export const createPushRouter = ({
  service,
  authMiddleware,
  mutationRateLimiter,
  clock,
}: PushRouterDependencies): Router => {
  const router = Router();

  router.use(disableCaching);
  router.use(authMiddleware);

  router.get(
    '/public-key',
    (
      request: Request,
      response: Response<PushPublicKeyResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      requireAuthenticatedPrincipal(request);

      void service
        .getPublicKey()
        .then((configuration) => response.status(200).json(configuration))
        .catch(next);
    },
  );

  router.post(
    '/subscriptions',
    mutationRateLimiter,
    (
      request: Request,
      response: Response<PushSubscriptionResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .subscribe(userId, request.body, request.get('user-agent'))
        .then((subscription) => response.status(200).json(subscription))
        .catch(next);
    },
  );

  router.delete(
    '/subscriptions',
    mutationRateLimiter,
    (request: Request, response: Response<void | ApiErrorResponse>, next: NextFunction): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .unsubscribe(userId, request.body, clock.now())
        .then(() => response.status(204).send())
        .catch(next);
    },
  );

  return router;
};
