import { Router, type RequestHandler } from 'express';
import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import { createFixedWindowRateLimiter } from '../auth/rate-limit.js';
import type { TrainingService } from './service.js';
import type { TrainingMedia } from './media.js';
export const createTrainingRouter = (
  service: TrainingService,
  media: TrainingMedia,
  auth: RequestHandler,
): Router => {
  const router = Router();
  router.get('/media/:id', (req, res, next) => {
    void media.stream(req, res, req.params.id).catch((error) => {
      if (res.headersSent) res.destroy();
      else next(error);
    });
  });
  router.use(auth);
  router.use(
    createFixedWindowRateLimiter({
      windowMs: 60_000,
      maximumRequests: 180,
      errorMessage: 'Слишком много запросов. Подождите минуту.',
    }),
  );
  const user: typeof requireAuthenticatedPrincipal = requireAuthenticatedPrincipal;
  router.get('/students', (req, res, next) => {
    void service
      .listStudents(user(req).userId)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/students', (req, res, next) => {
    void service
      .createStudent(user(req).userId, req.body)
      .then((v) => res.status(201).json(v))
      .catch(next);
  });
  router.get('/students/:id', (req, res, next) => {
    void service
      .detail(user(req).userId, req.params.id)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/students/:id/invite', (req, res, next) => {
    void service
      .renewInvite(user(req).userId, req.params.id)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/students/:id/archive', (req, res, next) => {
    void service
      .archiveStudent(user(req).userId, req.params.id)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/students/:id/plans', (req, res, next) => {
    void service
      .createPlan(user(req).userId, req.params.id)
      .then((v) => res.status(201).json(v))
      .catch(next);
  });
  router.post('/invitation', (req, res, next) => {
    void service
      .invitation(req.body)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/invitation/accept', (req, res, next) => {
    void service
      .acceptInvite(user(req).userId, req.body)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.get('/mine', (req, res, next) => {
    void service
      .myTraining(user(req).userId)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.put('/plans/:id', (req, res, next) => {
    void service
      .savePlan(user(req).userId, req.params.id, req.body)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/plans/:id/publish', (req, res, next) => {
    void service
      .publishPlan(user(req).userId, req.params.id, req.body)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.put('/workouts/:id/log', (req, res, next) => {
    void service
      .log(user(req).userId, req.params.id, req.body)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.get('/lessons', (req, res, next) => {
    void service
      .trainer(service.pool, user(req).userId)
      .then(() => media.cleanup())
      .then(() => service.library(user(req).userId))
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/lessons', (req, res, next) => {
    void service
      .createLesson(user(req).userId, req.body)
      .then((v) => res.status(201).json(v))
      .catch(next);
  });
  router.put('/lessons/:id/file', (req, res, next) => {
    void media
      .upload(user(req).userId, req.params.id, req)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.delete('/lessons/:id', (req, res, next) => {
    void media
      .remove(user(req).userId, req.params.id)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.get('/lessons/:id/access', (req, res, next) => {
    void media
      .access(user(req).userId, req.params.id)
      .then((v) => res.json(v))
      .catch(next);
  });
  return router;
};
