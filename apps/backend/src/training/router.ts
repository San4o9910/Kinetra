import { NutritionService } from './nutrition.js';
import { CoachProfiles } from './coach-profile.js';
import { LessonAssignments } from './lesson-assignments.js';
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
  const foodPhotos = new TrainingProgressPhotos(media, 'meal');
  router.get('/nutrition-photos/:id', (req, res, next) => {
    void foodPhotos.stream(String(req.params.id ?? ''), req.query.token, res).catch(next);
  });
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
  const assignments = new LessonAssignments(service);
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
  const nutrition = new NutritionService(service);
  const coaches = new CoachProfiles(service);
  endpoint('get', '/coach-profile', (id) => coaches.profile(id));
  endpoint('get', '/my-coach', (id) => coaches.mine(id));
  endpoint('put', '/my-coach/rating', (id, req) => coaches.review(id, req.body));
  endpoint('get', '/nutrition', (id, req) => nutrition.list(id, req.query.date));
  endpoint('get', '/students/:id/nutrition', (id, req) =>
    nutrition.list(id, req.query.date, String(req.params.id ?? '')),
  );
  endpoint('put', '/nutrition/:id', (id, req) =>
    nutrition.save(id, String(req.params.id ?? ''), req.body),
  );
  endpoint('delete', '/nutrition/:id', (id, req) =>
    foodPhotos.remove(id, String(req.params.id ?? '')),
  );
  endpoint('put', '/nutrition/:id/sharing', (id, req) =>
    foodPhotos.share(id, String(req.params.id ?? ''), req.body),
  );
  endpoint('delete', '/nutrition/:id/photo', (id, req) =>
    foodPhotos.removePhoto(id, String(req.params.id ?? '')),
  );
  endpoint('get', '/nutrition/:id/photo', (id, req) =>
    foodPhotos.access(id, String(req.params.id ?? '')),
  );
  router.put(
    '/nutrition/:id/photo',
    raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '10mb' }),
    (req, res, next) => {
      void foodPhotos
        .upload(user(req).userId, String(req.params.id ?? ''), req.body)
        .then((v) => res.json(v))
        .catch(next);
    },
  );
  endpoint('get', '/nutrition-templates', (id) => nutrition.templates(id));
  endpoint('put', '/nutrition-templates/:id', (id, req) =>
    nutrition.saveTemplate(id, String(req.params.id ?? ''), req.body),
  );
  endpoint('delete', '/nutrition-templates/:id', (id, req) =>
    nutrition.removeTemplate(id, String(req.params.id ?? '')),
  );
  endpoint('post', '/nutrition-templates/:id/apply', (id, req) =>
    nutrition.apply(id, String(req.params.id ?? ''), req.body),
  );
  endpoint('get', '/lessons/:id/assignments', (id, req) =>
    assignments.recipients(id, String(req.params.id ?? '')),
  );
  endpoint('post', '/lessons/:id/assignments', (id, req) =>
    assignments.assign(id, String(req.params.id ?? ''), req.body),
  );
  endpoint('delete', '/lessons/:id/assignments/:student', (id, req) =>
    assignments.revoke(id, String(req.params.id ?? ''), String(req.params.student ?? '')),
  );
  endpoint('put', '/lessons/:id/progress', (id, req) =>
    assignments.progress(id, String(req.params.id ?? ''), req.body),
  );
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
