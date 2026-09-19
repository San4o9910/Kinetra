import type {
  ApiErrorResponse,
  CreatePaymentResponse,
  SubscriptionResponse,
} from '@kinetra/shared';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { HttpError } from '../auth/errors.js';
import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import type { PaymentsService } from './service.js';
import type { WebhookSourceVerifier } from './webhook-source.js';
import type { FreeBetaAccessChecker } from '../program/free-beta-access.js';

export interface PaymentsRouterDependencies {
  readonly enabled?: boolean;
  readonly freeBetaAccess?: FreeBetaAccessChecker;
  readonly service: PaymentsService;
  readonly authMiddleware: RequestHandler;
  readonly webhookSourceVerifier: WebhookSourceVerifier;
}

const disableCaching = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  next();
};

export const createPaymentsRouter = ({
  enabled = true,
  freeBetaAccess,
  service,
  authMiddleware,
  webhookSourceVerifier,
}: PaymentsRouterDependencies): Router => {
  const router = Router();
  const requirePaymentsEnabled: RequestHandler = (_request, _response, next): void => {
    next(
      enabled
        ? undefined
        : new HttpError(503, 'PAYMENTS_DISABLED', 'Payments are not available yet.'),
    );
  };

  router.use(disableCaching);

  router.post(
    '/webhook',
    requirePaymentsEnabled,
    (request: Request, _response: Response, next: NextFunction): void => {
      if (!webhookSourceVerifier.isAllowed(request.ip)) {
        next(
          new HttpError(
            403,
            'PAYMENT_WEBHOOK_SOURCE_FORBIDDEN',
            'The payment webhook source is not allowed.',
          ),
        );
        return;
      }

      next();
    },
    (request: Request, response: Response<void | ApiErrorResponse>, next: NextFunction): void => {
      void service
        .handleWebhook(request.body)
        .then(() => response.status(200).send())
        .catch(next);
    },
  );

  router.post(
    '/create',
    authMiddleware,
    requirePaymentsEnabled,
    (
      request: Request,
      response: Response<CreatePaymentResponse | ApiErrorResponse>,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .createPayment(userId, request.body)
        .then((payment) => response.status(201).json(payment))
        .catch(next);
    },
  );

  router.post(
    '/cancel-subscription',
    authMiddleware,
    (
      request: Request,
      response: Response<
        | (SubscriptionResponse & {
            readonly payments_enabled?: false;
            readonly training_access?: 'free_beta';
          })
        | ApiErrorResponse
      >,
      next: NextFunction,
    ): void => {
      const { userId } = requireAuthenticatedPrincipal(request);

      void service
        .cancelSubscription(userId)
        .then(async (subscription) => {
          if (enabled) return response.status(200).json(subscription);
          const beta =
            freeBetaAccess !== undefined && (await freeBetaAccess.hasFreeBetaAccess(userId));
          return response.status(200).json({
            ...subscription,
            payments_enabled: false,
            ...(beta ? { training_access: 'free_beta' as const } : {}),
          });
        })
        .catch(next);
    },
  );

  return router;
};
