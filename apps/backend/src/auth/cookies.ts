import type { CookieOptions, Request, Response } from 'express';

export interface RefreshCookieConfig {
  readonly name: string;
  readonly secure: boolean;
  readonly sameSite: 'lax' | 'strict' | 'none';
  readonly maxAgeMs: number;
}

const baseCookieOptions = (config: RefreshCookieConfig): CookieOptions => ({
  httpOnly: true,
  secure: config.secure,
  sameSite: config.sameSite,
  path: '/api/v1/auth',
});

export const setRefreshTokenCookie = (
  response: Response,
  refreshToken: string,
  config: RefreshCookieConfig,
): void => {
  response.cookie(config.name, refreshToken, {
    ...baseCookieOptions(config),
    maxAge: config.maxAgeMs,
  });
};

export const clearRefreshTokenCookie = (
  response: Response,
  config: RefreshCookieConfig,
): void => {
  response.clearCookie(config.name, baseCookieOptions(config));
};

export const readCookie = (request: Request, name: string): string | null => {
  const rawCookieHeader = request.headers.cookie;

  if (rawCookieHeader === undefined) {
    return null;
  }

  for (const part of rawCookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');

    if (separatorIndex < 0) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();

    if (key !== name) {
      continue;
    }

    const rawValue = part.slice(separatorIndex + 1).trim();

    try {
      return decodeURIComponent(rawValue);
    } catch {
      return null;
    }
  }

  return null;
};
