import type {
  ApiErrorResponse,
  TrainerVerificationListResponse,
  TrainerVerificationMeResponse,
  TrainerVerificationRequestDto,
} from '@kinetra/shared';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import type { TrainerVerificationService } from './service.js';

export interface TrainerVerificationRouterDependencies {
  readonly service: TrainerVerificationService;
  readonly authMiddleware: RequestHandler;
}

const disableCaching = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  next();
};

export const createTrainerVerificationRouter = ({
  service,
  authMiddleware,
}: TrainerVerificationRouterDependencies): Router => {
  const router = Router();
  router.use(disableCaching);
  router.use(authMiddleware);

  router.get(
    '/me',
    (
      request: Request,
      response: Response<TrainerVerificationMeResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);
      void service
        .getMe(userId)
        .then((result) => response.status(200).json(result))
        .catch(next);
    },
  );

  router.post(
    '/',
    (
      request: Request,
      response: Response<TrainerVerificationMeResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);
      void service
        .submit(userId, request.body)
        .then((result) => response.status(201).json(result))
        .catch(next);
    },
  );

  router.patch(
    '/me',
    (
      request: Request,
      response: Response<TrainerVerificationMeResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);
      void service
        .update(userId, request.body)
        .then((result) => response.status(200).json(result))
        .catch(next);
    },
  );

  router.post(
    '/me/withdraw',
    (
      request: Request,
      response: Response<TrainerVerificationMeResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);
      void service
        .withdraw(userId, request.body)
        .then((result) => response.status(200).json(result))
        .catch(next);
    },
  );

  return router;
};

export const createTrainerVerificationAdminRouter = ({
  service,
  authMiddleware,
}: TrainerVerificationRouterDependencies): Router => {
  const router = Router();
  router.use(disableCaching);
  router.use(authMiddleware);

  router.get(
    '/',
    (
      request: Request,
      response: Response<TrainerVerificationListResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);
      void service
        .list(userId, request.query.status)
        .then((result) => response.status(200).json(result))
        .catch(next);
    },
  );

  const reviewHandler =
    (action: 'approve' | 'request-info' | 'reject') =>
    (
      request: Request<{ id: string }>,
      response: Response<TrainerVerificationRequestDto | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);
      const operation =
        action === 'approve'
          ? service.approve(userId, request.params.id, request.body)
          : action === 'request-info'
            ? service.requestInfo(userId, request.params.id, request.body)
            : service.reject(userId, request.params.id, request.body);
      void operation.then((result) => response.status(200).json(result)).catch(next);
    };

  router.post('/:id/approve', reviewHandler('approve'));
  router.post('/:id/request-info', reviewHandler('request-info'));
  router.post('/:id/reject', reviewHandler('reject'));
  return router;
};
