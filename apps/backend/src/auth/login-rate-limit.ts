import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { normalizeIdentifier } from './normalization.js';
import { HttpError } from './errors.js';
import { createFixedWindowRateLimiter } from './rate-limit.js';

/** Bound pre-hash work per IP and per account identifier, including unknown accounts. */
export const createLoginRateLimiter = (): RequestHandler => {
  const windowMs = 15 * 60_000;
  const ipLimit = createFixedWindowRateLimiter({
    windowMs,
    maximumRequests: 30,
    errorCode: 'LOGIN_RATE_LIMITED',
    errorMessage: 'Слишком много попыток входа. Попробуйте через 15 минут.',
  });
  const accounts = new Map<string, { count: number; resetAt: number }>();
  return (request, response, next) => {
    ipLimit(request, response, (error?: unknown) => {
      if (error !== undefined) {
        next(error);
        return;
      }
      const identifier: unknown =
        request.body?.identifier ?? request.body?.email ?? request.body?.phone;
      if (typeof identifier !== 'string') {
        next();
        return;
      }
      const now = Date.now();
      for (const [key, entry] of accounts) if (entry.resetAt <= now) accounts.delete(key);
      const key = createHash('sha256')
        .update(
          normalizeIdentifier(identifier, true)?.value ??
            identifier.normalize('NFKC').trim().toLowerCase().slice(0, 320),
        )
        .digest('hex');
      const entry = accounts.get(key) ?? { count: 0, resetAt: now + windowMs };
      if (entry.count >= 10 || (!accounts.has(key) && accounts.size >= 10_000)) {
        response.setHeader(
          'Retry-After',
          String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))),
        );
        next(
          new HttpError(
            429,
            'LOGIN_RATE_LIMITED',
            'Слишком много попыток входа. Попробуйте через 15 минут.',
          ),
        );
        return;
      }
      entry.count += 1;
      accounts.set(key, entry);
      response.once('finish', () => {
        if (response.statusCode === 200 && accounts.get(key) === entry) accounts.delete(key);
      });
      next();
    });
  };
};
