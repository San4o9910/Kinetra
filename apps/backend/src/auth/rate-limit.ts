import type { ApiErrorResponse } from '@kinetra/shared';
import type { RequestHandler } from 'express';

export interface FixedWindowRateLimitOptions {
  readonly windowMs: number;
  readonly maximumRequests: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

interface Counter {
  count: number;
  resetAt: number;
}

export const createFixedWindowRateLimiter = (
  options: FixedWindowRateLimitOptions,
): RequestHandler => {
  const counters = new Map<string, Counter>();
  let lastSweepAt = 0;

  return (request, response, next): void => {
    const now = Date.now();

    if (now - lastSweepAt >= options.windowMs) {
      for (const [candidateKey, candidate] of counters) {
        if (candidate.resetAt <= now) {
          counters.delete(candidateKey);
        }
      }

      lastSweepAt = now;
    }

    const key = request.ip || request.socket.remoteAddress || 'unknown';
    const existing = counters.get(key);
    const counter =
      existing === undefined || existing.resetAt <= now
        ? { count: 0, resetAt: now + options.windowMs }
        : existing;

    counter.count += 1;
    counters.set(key, counter);

    response.setHeader('RateLimit-Limit', String(options.maximumRequests));
    response.setHeader(
      'RateLimit-Remaining',
      String(Math.max(0, options.maximumRequests - counter.count)),
    );
    response.setHeader('RateLimit-Reset', String(Math.ceil(counter.resetAt / 1000)));

    if (counter.count <= options.maximumRequests) {
      next();
      return;
    }

    response.setHeader('Retry-After', String(Math.ceil((counter.resetAt - now) / 1000)));
    const requestId =
      typeof response.locals.requestId === 'string' ? response.locals.requestId : undefined;
    const body: ApiErrorResponse = {
      error: {
        code: options.errorCode ?? 'RATE_LIMITED',
        message: options.errorMessage ?? 'Too many password-reset requests. Try again later.',
        ...(requestId === undefined ? {} : { requestId }),
      },
    };

    response.status(429).json(body);
  };
};
