import { TrainingProgressPhotos } from './progress-photos.js';
import { ResumableTrainingMedia } from './resumable-media.js';
import { TrainingExperience } from './experience.js';
import { Router, raw, type Request, type RequestHandler } from 'express';
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
  const uploads = new ResumableTrainingMedia(media);
  const photos = new TrainingProgressPhotos(media);
  router.get('/progress-photos/:id', (req, res, next) => {
    void photos.stream(String(req.params.id ?? ''), req.query.token, res).catch(next);
  });
  router.get('/thumbnails/:id', (req, res, next) => {
    void uploads.thumbnail(req, res, String(req.params.id ?? '')).catch(next);
  });
  router.get('/media/:id', (req, res, next) => {
    void media.stream(req, res, String(req.params.id ?? '')).catch((error) => {
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
  const experience = new TrainingExperience(service);
  const endpoint = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    fn: (id: string, request: Request) => Promise<unknown>,
  ) => {
    router[method](path, (req, res, next) => {
      void fn(user(req).userId, req)
        .then((v) => res.json(v))
        .catch(next);
    });
  };
  endpoint('get', '/lessons/:id/upload', (id, req) =>
    uploads.status(id, String(req.params.id ?? '')),
  );
  endpoint('put', '/lessons/:id/chunk', (id, req) =>
    uploads.chunk(id, String(req.params.id ?? ''), req),
  );
  endpoint('post', '/lessons/:id/finish', (id, req) =>
    uploads.finish(id, String(req.params.id ?? '')),
  );
  endpoint('post', '/lessons/:id/cancel', (id, req) =>
    uploads.cancel(id, String(req.params.id ?? '')),
  );
  router.put(
    '/measurements/:id/photo',
    raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '10mb' }),
    (req, res, next) => {
      void photos
        .upload(user(req).userId, String(req.params.id ?? ''), req.body)
        .then((v) => res.json(v))
        .catch(next);
    },
  );
  endpoint('get', '/measurements/:id/photo', (id, req) =>
    photos.access(id, String(req.params.id ?? '')),
  );
  endpoint('delete', '/measurements/:id', (id, req) =>
    photos.remove(id, String(req.params.id ?? '')),
  );
  endpoint('put', '/measurements/:id/sharing', (id, req) =>
    photos.share(id, String(req.params.id ?? ''), req.body),
  );
  endpoint('get', '/templates', (id) => experience.templates(id));
  endpoint('post', '/plans/:id/template', (id, req) =>
    experience.saveTemplate(id, String(req.params.id ?? '')),
  );
  endpoint('delete', '/templates/:id', (id, req) =>
    experience.removeTemplate(id, String(req.params.id ?? '')),
  );
  endpoint('post', '/students/:id/template', (id, req) =>
    experience.assignTemplate(id, String(req.params.id ?? ''), req.body),
  );
  endpoint('get', '/attention', (id) => experience.attention(id));
  endpoint('post', '/students/:id/seen', (id, req) =>
    experience.seen(id, String(req.params.id ?? '')),
  );
  endpoint('post', '/workouts/:id/reschedule', (id, req) =>
    experience.requestReschedule(id, String(req.params.id ?? ''), req.body),
  );
  endpoint('get', '/reschedules', (id) => experience.reschedules(id));
  endpoint('post', '/reschedules/:id/review', (id, req) =>
    experience.reviewReschedule(id, String(req.params.id ?? ''), req.body),
  );
  endpoint('get', '/measurements', (id) => experience.measurements(id));
  endpoint('get', '/students/:id/measurements', (id, req) =>
    experience.measurements(id, String(req.params.id ?? '')),
  );
  endpoint('post', '/measurements', (id, req) => experience.addMeasurement(id, req.body));
  endpoint('get', '/complaints', (id) => experience.complaints(id));
  endpoint('post', '/complaints', (id, req) => experience.complain(id, req.body));
  endpoint('get', '/admin/complaints', (id) => experience.complaints(id, true));
  endpoint('post', '/admin/complaints/:id', (id, req) =>
    experience.reviewComplaint(id, String(req.params.id ?? ''), req.body),
  );
  endpoint('get', '/admin/verification/:id/history', (id, req) =>
    experience.verificationHistory(id, String(req.params.id ?? '')),
  );
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
      .detail(user(req).userId, String(req.params.id ?? ''))
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/students/:id/invite', (req, res, next) => {
    void service
      .renewInvite(user(req).userId, String(req.params.id ?? ''))
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/students/:id/archive', (req, res, next) => {
    void service
      .archiveStudent(user(req).userId, String(req.params.id ?? ''))
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/students/:id/plans', (req, res, next) => {
    void service
      .createPlan(user(req).userId, String(req.params.id ?? ''))
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
      .savePlan(user(req).userId, String(req.params.id ?? ''), req.body)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.post('/plans/:id/publish', (req, res, next) => {
    void service
      .publishPlan(user(req).userId, String(req.params.id ?? ''), req.body)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.put('/workouts/:id/log', (req, res, next) => {
    void service
      .log(user(req).userId, String(req.params.id ?? ''), req.body)
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
      .upload(user(req).userId, String(req.params.id ?? ''), req)
      .then((v) => res.json(v))
      .catch(next);
  });
  router.delete('/lessons/:id', (req, res, next) => {
    void media
      .remove(user(req).userId, String(req.params.id ?? ''))
      .then((v) => res.json(v))
      .catch(next);
  });
  router.get('/lessons/:id/access', (req, res, next) => {
    void media
      .access(user(req).userId, String(req.params.id ?? ''))
      .then((v) => res.json(v))
      .catch(next);
  });
  return router;
};
