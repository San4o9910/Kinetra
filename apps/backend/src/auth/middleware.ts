import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { HttpError } from './errors.js';
import type { AccessTokenClaims } from './tokens.js';

export interface AccessTokenVerifier {
  verify(token: string, now?: Date): Promise<AccessTokenClaims>;
}

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly sessionId: string;
}

const authenticationError = (): HttpError =>
  new HttpError(401, 'AUTHENTICATION_REQUIRED', 'A valid access token is required.');

const bearerTokenFrom = (request: Request): string => {
  const authorization = request.get('authorization');

  if (authorization === undefined) {
    throw authenticationError();
  }

  const parts = authorization.trim().split(/\s+/u);

  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
    throw authenticationError();
  }

  return parts[1];
};

export const createAuthMiddleware = (verifier: AccessTokenVerifier): RequestHandler => {
  return (request: Request, _response: Response, next: NextFunction): void => {
    let token: string;

    try {
      token = bearerTokenFrom(request);
    } catch (error) {
      next(error);
      return;
    }

    void verifier
      .verify(token)
      .then((claims) => {
        request.auth = {
          userId: claims.sub,
          sessionId: claims.sid,
        };
        next();
      })
      .catch(() => next(authenticationError()));
  };
};

export const requireAuthenticatedPrincipal = (request: Request): AuthenticatedPrincipal => {
  if (request.auth === undefined) {
    throw authenticationError();
  }

  return request.auth;
};
