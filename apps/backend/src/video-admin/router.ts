import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import {
  createUploadSchema,
  daySchema,
  emptyObjectSchema,
  parseVideoInput,
  signPartsSchema,
  uuidSchema,
  weekSchema,
} from './schema.js';
import type { VideoAdminService } from './service.js';

export interface VideoAdminRouterDependencies {
  readonly service: VideoAdminService;
  readonly authMiddleware: RequestHandler;
}

const privateHeaders = (_request: Request, response: Response, next: NextFunction): void => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};

export const createVideoAdminRouter = ({
  service,
  authMiddleware,
}: VideoAdminRouterDependencies): Router => {
  const router = Router();
  router.use(privateHeaders);
  router.use(authMiddleware);

  router.get('/program', (request, response, next): void => {
    void service
      .getProgram(requireAuthenticatedPrincipal(request).userId)
      .then((value) => response.status(200).json(value))
      .catch(next);
  });

  router.post('/uploads', (request, response, next): void => {
    try {
      const idempotencyKey = parseVideoInput(uuidSchema, request.get('idempotency-key'));
      const body = parseVideoInput(createUploadSchema, request.body);
      void service
        .createUpload(requireAuthenticatedPrincipal(request).userId, idempotencyKey, body)
        .then(({ created, upload }) => response.status(created ? 201 : 200).json({ upload }))
        .catch(next);
    } catch (caught) {
      next(caught);
    }
  });

  router.post('/uploads/:uploadId/parts', (request, response, next): void => {
    try {
      const uploadId = parseVideoInput(uuidSchema, request.params.uploadId);
      const body = parseVideoInput(signPartsSchema, request.body);
      void service
        .signParts(requireAuthenticatedPrincipal(request).userId, uploadId, body.parts)
        .then((parts) => response.status(200).json({ parts }))
        .catch(next);
    } catch (caught) {
      next(caught);
    }
  });

  router.get('/uploads/:uploadId/parts', (request, response, next): void => {
    try {
      const uploadId = parseVideoInput(uuidSchema, request.params.uploadId);
      parseVideoInput(emptyObjectSchema, request.query);
      void service
        .listParts(requireAuthenticatedPrincipal(request).userId, uploadId)
        .then((value) => response.status(200).json(value))
        .catch(next);
    } catch (caught) {
      next(caught);
    }
  });

  router.post('/uploads/:uploadId/complete', (request, response, next): void => {
    try {
      const uploadId = parseVideoInput(uuidSchema, request.params.uploadId);
      parseVideoInput(emptyObjectSchema, request.body ?? {});
      void service
        .complete(requireAuthenticatedPrincipal(request).userId, uploadId)
        .then((upload) => {
          response.setHeader('Retry-After', '2');
          response.status(202).json({ upload });
        })
        .catch(next);
    } catch (caught) {
      next(caught);
    }
  });

  router.get('/uploads/:uploadId', (request, response, next): void => {
    try {
      const uploadId = parseVideoInput(uuidSchema, request.params.uploadId);
      parseVideoInput(emptyObjectSchema, request.query);
      void service
        .getUpload(requireAuthenticatedPrincipal(request).userId, uploadId)
        .then((upload) => {
          if (
            ['creating', 'uploading', 'completing', 'verification_pending', 'verifying'].includes(
              upload.status,
            )
          )
            response.setHeader('Retry-After', '2');
          response.status(200).json({ upload });
        })
        .catch(next);
    } catch (caught) {
      next(caught);
    }
  });

  router.delete('/uploads/:uploadId', (request, response, next): void => {
    try {
      const uploadId = parseVideoInput(uuidSchema, request.params.uploadId);
      parseVideoInput(emptyObjectSchema, request.body ?? {});
      void service
        .cancel(requireAuthenticatedPrincipal(request).userId, uploadId)
        .then((upload) => response.status(200).json({ upload }))
        .catch(next);
    } catch (caught) {
      next(caught);
    }
  });

  router.get('/workouts/:videoId/preview-url', (request, response, next): void => {
    try {
      const videoId = parseVideoInput(uuidSchema, request.params.videoId);
      parseVideoInput(emptyObjectSchema, request.query);
      void service
        .preview(requireAuthenticatedPrincipal(request).userId, videoId)
        .then((value) => response.status(200).json(value))
        .catch(next);
    } catch (caught) {
      next(caught);
    }
  });

  router.post('/weeks/:weekNumber/days/:dayOfWeek/unpublish', (request, response, next): void => {
    try {
      const weekNumber = parseVideoInput(weekSchema, request.params.weekNumber);
      const dayOfWeek = parseVideoInput(daySchema, request.params.dayOfWeek);
      parseVideoInput(emptyObjectSchema, request.body ?? {});
      void service
        .unpublish(requireAuthenticatedPrincipal(request).userId, weekNumber, dayOfWeek)
        .then((value) => response.status(200).json(value))
        .catch(next);
    } catch (caught) {
      next(caught);
    }
  });

  return router;
};
