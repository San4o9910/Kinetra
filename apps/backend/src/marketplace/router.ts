import { Router, type Request } from 'express';
import { requireAuthenticatedPrincipal } from '../auth/middleware.js';
import { createFixedWindowRateLimiter } from '../auth/rate-limit.js';
import { MarketplaceService } from './service.js';
import { type TrainingService } from '../training/service.js';
const limiter = () =>
  createFixedWindowRateLimiter({
    windowMs: 60_000,
    maximumRequests: 120,
    errorMessage: 'Слишком много запросов. Подождите минуту.',
  });
export const createPublicMarketplaceRouter = (training: TrainingService) => {
  const router = Router(),
    service = new MarketplaceService(training);
  router.use(limiter());
  const get = (path: string, fn: (req: Request) => Promise<unknown>) =>
    router.get(path, (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      void fn(req)
        .then((v) => res.json(v))
        .catch(next);
    });
  get('/', (req) => service.catalogue(req.query));
  get('/coaches/:id', (req) => service.profile(String(req.params.id)));
  get('/offers/:id', (req) => service.offer(String(req.params.id)));
  return router;
};
// Mounted after the training router's authentication middleware.
export const createMarketplaceOwnerRouter = (training: TrainingService) => {
  const router = Router(),
    service = new MarketplaceService(training);
  router.use(limiter());
  const endpoint = (
    method: 'get' | 'post' | 'put',
    path: string,
    fn: (user: string, req: Request) => Promise<unknown>,
  ) =>
    router[method](path, (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      void fn(requireAuthenticatedPrincipal(req).userId, req)
        .then((v) => res.json(v))
        .catch(next);
    });
  endpoint('get', '/workspace', (u) => service.workspace(u));
  endpoint('get', '/review', (u) => service.queue(u));
  endpoint('put', '/profile', (u, r) => service.save(u, 'profile', u, r.body));
  endpoint('put', '/offers/:id', (u, r) => service.save(u, 'offer', String(r.params.id), r.body));
  for (const kind of ['profile', 'offer'] as const) {
    const path = kind === 'profile' ? '/profile' : '/offers/:id';
    const id = (u: string, r: Request) => (kind === 'profile' ? u : String(r.params.id));
    endpoint('post', `${path}/submit`, (u, r) => service.submit(u, kind, id(u, r), r.body));
    endpoint('post', `${path}/pause`, (u, r) => service.pause(u, kind, id(u, r), r.body));
    endpoint('post', `/review/${kind}/:id`, (u, r) =>
      service.review(u, kind, String(r.params.id), r.body),
    );
  }
  return router;
};
