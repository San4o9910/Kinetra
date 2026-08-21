import type {
  ApiErrorResponse,
  SettingsProfileResponse,
  SubscriptionResponse,
} from '@kinetra/shared';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import { clearRefreshTokenCookie, type RefreshCookieConfig } from '../auth/cookies.js';
import type { SettingsService } from './service.js';

export interface SettingsRouterDependencies {
  readonly service: SettingsService;
  readonly authMiddleware: RequestHandler;
  readonly refreshCookie: RefreshCookieConfig;
}

const disableCaching = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  next();
};

export const createSettingsRouter = ({
  service,
  authMiddleware,
  refreshCookie,
}: SettingsRouterDependencies): Router => {
  const router = Router();

  router.use(disableCaching);
  router.use(authMiddleware);

  router.get(
    '/subscription',
    (request: Request, response: Response<SubscriptionResponse>, next: NextFunction): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .getSubscription(userId)
        .then((subscription) => response.status(200).json(subscription))
        .catch(next);
    },
  );

  router.get(
    '/profile',
    (request: Request, response: Response<SettingsProfileResponse>, next: NextFunction): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .getProfile(userId)
        .then((profile) => response.status(200).json(profile))
        .catch(next);
    },
  );

  router.put(
    '/notifications',
    (request: Request, response: Response<void | ApiErrorResponse>, next: NextFunction): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .updateNotifications(userId, request.body)
        .then(() => response.status(204).send())
        .catch(next);
    },
  );

  router.delete(
    '/account',
    (request: Request, response: Response<void | ApiErrorResponse>, next: NextFunction): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .deleteAccount(userId, request.body)
        .then(() => {
          clearRefreshTokenCookie(response, refreshCookie);
          response.status(204).send();
        })
        .catch(next);
    },
  );

  return router;
};
