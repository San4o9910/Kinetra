import { Router, type RequestHandler } from 'express';
import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import { createFixedWindowRateLimiter } from '../auth/rate-limit.js';
import type { CoachingService } from './service.js';

export const createCoachingRouter = (service: CoachingService, auth: RequestHandler): Router => {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(auth);
  router.get('/workouts/:videoId/:week', (request, response, next) => {
    void service
      .getSession(
        requireAuthenticatedPrincipal(request).userId,
        request.params.videoId,
        request.params.week,
      )
      .then((result) => response.json(result))
      .catch(next);
  });
  router.put('/workouts/:videoId/:week', (request, response, next) => {
    void service
      .saveSession(
        requireAuthenticatedPrincipal(request).userId,
        request.params.videoId,
        request.params.week,
        request.body,
      )
      .then(() => response.json({ saved: true }))
      .catch(next);
  });
  router.get('/guides/:videoId', (request, response, next) => {
    void service
      .getGuide(requireAuthenticatedPrincipal(request).userId, request.params.videoId)
      .then((result) => response.json(result))
      .catch(next);
  });
  router.put('/guides/:videoId', (request, response, next) => {
    void service
      .saveGuide(
        requireAuthenticatedPrincipal(request).userId,
        request.params.videoId,
        request.body,
      )
      .then((result) => response.json(result))
      .catch(next);
  });
  router.get('/clients/:conversationId', (request, response, next) => {
    void service
      .clientContext(requireAuthenticatedPrincipal(request).userId, request.params.conversationId)
      .then((result) => response.json(result))
      .catch(next);
  });
  router.get('/assistant', (request, response, next) => {
    void service
      .history(requireAuthenticatedPrincipal(request).userId)
      .then((result) => response.json(result))
      .catch(next);
  });
  router.post(
    '/assistant',
    createFixedWindowRateLimiter({
      windowMs: 60_000,
      maximumRequests: 12,
      errorMessage: 'Слишком много вопросов. Подождите минуту.',
    }),
    (request, response, next) => {
      void service
        .ask(requireAuthenticatedPrincipal(request).userId, request.body)
        .then((result) => response.json(result))
        .catch(next);
    },
  );
  return router;
};
