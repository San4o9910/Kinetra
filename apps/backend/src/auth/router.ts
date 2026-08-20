import type {
  LoginRequest,
  MessageResponse,
  PasswordResetConfirmRequest,
  PasswordResetRequest,
  RegisterRequest,
  RegisterResponse,
  VerifyEmailRequest,
} from '@kinetra/shared';
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {
  clearRefreshTokenCookie,
  readCookie,
  setRefreshTokenCookie,
  type RefreshCookieConfig,
} from './cookies.js';
import { HttpError } from './errors.js';
import { PASSWORD_RESET_REQUEST_MESSAGE, type AuthService } from './service.js';

export interface AuthRouterOptions {
  readonly service: AuthService;
  readonly refreshCookie: RefreshCookieConfig;
  readonly passwordResetRateLimiter: RequestHandler;
}

type JsonObject = Record<string, unknown>;

const asJsonObject = (value: unknown): JsonObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_REQUEST_BODY', 'Request body must be a JSON object.');
  }

  return value as JsonObject;
};

const asJsonObjectOrEmpty = (value: unknown): JsonObject =>
  value === undefined ? {} : asJsonObject(value);

const assertNoUserIdOverride = (body: JsonObject): void => {
  if (Object.hasOwn(body, 'userId') || Object.hasOwn(body, 'user_id')) {
    throw new HttpError(
      400,
      'USER_ID_NOT_ALLOWED',
      'User identity must come from verified authentication context, not from the request body.',
    );
  }
};

const readRequiredString = (body: JsonObject, field: string): string => {
  const value = body[field];

  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be a non-empty string.`);
  }

  return value;
};

const readOptionalString = (body: JsonObject, field: string): string | undefined => {
  const value = body[field];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be a non-empty string.`);
  }

  return value;
};

const readIdentifier = (body: JsonObject): string => {
  const candidates = ['identifier', 'email', 'phone']
    .filter((field) => body[field] !== undefined)
    .map((field) => ({ field, value: readRequiredString(body, field) }));

  if (candidates.length !== 1) {
    throw new HttpError(
      400,
      'IDENTIFIER_REQUIRED',
      'Provide exactly one of identifier, email, or phone.',
    );
  }

  const candidate = candidates[0];

  if (candidate === undefined) {
    throw new HttpError(400, 'IDENTIFIER_REQUIRED', 'Identifier is required.');
  }

  return candidate.value;
};

export const createAuthRouter = (options: AuthRouterOptions): Router => {
  const router = Router();

  router.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    next();
  });

  router.post('/register', async (request, response) => {
    const body = asJsonObject(request.body);
    assertNoUserIdOverride(body);
    const email = readOptionalString(body, 'email');
    const phone = readOptionalString(body, 'phone');
    const registerRequest: RegisterRequest = {
      ...(email === undefined ? {} : { email }),
      ...(phone === undefined ? {} : { phone }),
      password: readRequiredString(body, 'password'),
    };
    const result = await options.service.register(registerRequest);

    if (result.kind === 'verification-required') {
      response.status(201).json(result.response satisfies RegisterResponse);
      return;
    }

    setRefreshTokenCookie(response, result.session.refreshToken, options.refreshCookie);
    response.status(201).json(result.session.response satisfies RegisterResponse);
  });

  router.post('/login', async (request, response) => {
    const body = asJsonObject(request.body);
    assertNoUserIdOverride(body);
    const loginRequest: LoginRequest = {
      identifier: readIdentifier(body),
      password: readRequiredString(body, 'password'),
    };
    const session = await options.service.login({
      identifier: loginRequest.identifier ?? '',
      password: loginRequest.password,
    });

    setRefreshTokenCookie(response, session.refreshToken, options.refreshCookie);
    response.status(200).json(session.response);
  });

  router.post('/refresh', async (request, response) => {
    const body = asJsonObjectOrEmpty(request.body);
    assertNoUserIdOverride(body);
    const refreshToken = readCookie(request, options.refreshCookie.name);

    if (refreshToken === null) {
      throw new HttpError(401, 'REFRESH_TOKEN_REQUIRED', 'Refresh session is required.');
    }

    try {
      const session = await options.service.refresh(refreshToken);
      setRefreshTokenCookie(response, session.refreshToken, options.refreshCookie);
      response.status(200).json(session.response);
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 401) {
        clearRefreshTokenCookie(response, options.refreshCookie);
      }

      throw error;
    }
  });

  router.post('/logout', async (request, response) => {
    const body = asJsonObjectOrEmpty(request.body);
    assertNoUserIdOverride(body);
    const refreshToken = readCookie(request, options.refreshCookie.name);
    await options.service.logout(refreshToken);
    clearRefreshTokenCookie(response, options.refreshCookie);
    response.status(204).send();
  });

  router.post(
    '/password-reset/request',
    options.passwordResetRateLimiter,
    async (request, response) => {
      const body = asJsonObject(request.body);
      assertNoUserIdOverride(body);
      const passwordResetRequest: PasswordResetRequest = {
        identifier: readIdentifier(body),
      };
      await options.service.requestPasswordReset(passwordResetRequest.identifier ?? '');
      const result: MessageResponse = { message: PASSWORD_RESET_REQUEST_MESSAGE };
      response.status(202).json(result);
    },
  );

  router.post('/password-reset/confirm', async (request, response) => {
    const body = asJsonObject(request.body);
    assertNoUserIdOverride(body);
    const passwordResetConfirmRequest: PasswordResetConfirmRequest = {
      token: readRequiredString(body, 'token'),
      newPassword: readRequiredString(body, 'newPassword'),
    };
    await options.service.confirmPasswordReset(
      passwordResetConfirmRequest.token,
      passwordResetConfirmRequest.newPassword,
    );
    clearRefreshTokenCookie(response, options.refreshCookie);
    const result: MessageResponse = { message: 'Password has been reset.' };
    response.status(200).json(result);
  });

  if (options.service.emailVerificationEnabled) {
    router.post('/verify-email', async (request, response) => {
      const body = asJsonObject(request.body);
      assertNoUserIdOverride(body);
      const verifyRequest: VerifyEmailRequest = {
        token: readRequiredString(body, 'token'),
      };
      const session = await options.service.verifyEmail(verifyRequest.token);
      setRefreshTokenCookie(response, session.refreshToken, options.refreshCookie);
      response.status(200).json(session.response);
    });
  }

  return router;
};
