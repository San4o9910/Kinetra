import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(currentDirectory, '../..');
const repositoryRoot = resolve(backendRoot, '../..');

loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true });

type NodeEnvironment = 'development' | 'test' | 'production';
type SameSiteMode = 'lax' | 'strict' | 'none';
type TokenDeliveryMode = 'console' | 'disabled';

export interface S3Environment {
  readonly endpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly presignedUrlTtlSeconds: number;
}

export interface YooKassaEnvironment {
  readonly shopId: string;
  readonly secretKey: string;
  readonly returnUrls: readonly string[];
  readonly requestTimeoutMs: number;
}

const DEVELOPMENT_ACCESS_SECRET = 'local-development-only-change-this-kinetra-access-secret-2026';

const parseInteger = (
  name: string,
  rawValue: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const value = Number(rawValue ?? String(fallback));

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }

  return value;
};

const parseBoolean = (name: string, rawValue: string | undefined, fallback: boolean): boolean => {
  const value = (rawValue ?? String(fallback)).trim().toLowerCase();

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${name} must be true or false.`);
};

const parseEnum = <T extends string>(
  name: string,
  rawValue: string | undefined,
  fallback: T,
  allowedValues: readonly T[],
): T => {
  const value = (rawValue ?? fallback).trim() as T;

  if (!allowedValues.includes(value)) {
    throw new Error(`${name} must be one of: ${allowedValues.join(', ')}.`);
  }

  return value;
};

const parseOrigins = (rawValue: string | undefined): string[] => {
  const origins = (rawValue ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error('CORS_ORIGIN must contain at least one origin.');
  }

  return origins;
};

const trimmedOrNull = (rawValue: string | undefined): string | null => {
  const value = rawValue?.trim();
  return value === undefined || value.length === 0 ? null : value;
};

const parseS3Environment = (nodeEnvironment: NodeEnvironment): Readonly<S3Environment> | null => {
  const endpoint = trimmedOrNull(process.env.S3_ENDPOINT);
  const region = trimmedOrNull(process.env.S3_REGION);
  const bucket = trimmedOrNull(process.env.S3_BUCKET);
  const accessKeyId = trimmedOrNull(process.env.S3_ACCESS_KEY_ID);
  const secretAccessKey = trimmedOrNull(process.env.S3_SECRET_ACCESS_KEY);
  const configuredValues = { region, bucket, accessKeyId, secretAccessKey } as const;
  const hasConfiguration = endpoint !== null || Object.values(configuredValues).some(Boolean);

  if (!hasConfiguration) {
    return null;
  }

  const missing = Object.entries(configuredValues)
    .filter(([, value]) => value === null)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`S3 configuration is incomplete. Missing: ${missing.join(', ')}.`);
  }

  if (endpoint !== null) {
    let parsedEndpoint: URL;

    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new Error('S3_ENDPOINT must be a valid HTTP or HTTPS URL.');
    }

    if (!['http:', 'https:'].includes(parsedEndpoint.protocol)) {
      throw new Error('S3_ENDPOINT must be a valid HTTP or HTTPS URL.');
    }

    if (nodeEnvironment === 'production' && parsedEndpoint.protocol !== 'https:') {
      throw new Error('S3_ENDPOINT must use HTTPS in production.');
    }
  }

  return Object.freeze({
    endpoint,
    region: region as string,
    bucket: bucket as string,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
    forcePathStyle: parseBoolean(
      'S3_FORCE_PATH_STYLE',
      process.env.S3_FORCE_PATH_STYLE,
      endpoint !== null,
    ),
    presignedUrlTtlSeconds: parseInteger(
      'S3_PRESIGNED_URL_TTL_SECONDS',
      process.env.S3_PRESIGNED_URL_TTL_SECONDS,
      900,
      60,
      86_400,
    ),
  });
};

const parseYooKassaEnvironment = (
  nodeEnvironment: NodeEnvironment,
): Readonly<YooKassaEnvironment> | null => {
  const shopId = trimmedOrNull(process.env.YUKASSA_SHOP_ID);
  const secretKey = trimmedOrNull(process.env.YUKASSA_SECRET_KEY);

  if (shopId === null && secretKey === null) {
    if (nodeEnvironment === 'production') {
      throw new Error('YUKASSA_SHOP_ID and YUKASSA_SECRET_KEY are required in production.');
    }

    return null;
  }

  if (shopId === null || secretKey === null) {
    throw new Error('YooKassa configuration is incomplete. Set both shop ID and secret key.');
  }

  const rawReturnUrls = process.env.YUKASSA_RETURN_URL ?? 'http://localhost:5173/payment/success';
  const returnUrls = rawReturnUrls
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      let url: URL;

      try {
        url = new URL(value);
      } catch {
        throw new Error('YUKASSA_RETURN_URL must contain valid absolute URLs.');
      }

      const localDevelopmentHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);

      if (
        url.protocol !== 'https:' &&
        !(nodeEnvironment !== 'production' && localDevelopmentHost)
      ) {
        throw new Error('YUKASSA_RETURN_URL must use HTTPS outside local development.');
      }

      url.hash = '';
      return url.toString();
    });

  if (returnUrls.length === 0) {
    throw new Error('YUKASSA_RETURN_URL must contain at least one allowed return URL.');
  }

  return Object.freeze({
    shopId,
    secretKey,
    returnUrls: Object.freeze(returnUrls),
    requestTimeoutMs: parseInteger(
      'YUKASSA_REQUEST_TIMEOUT_MS',
      process.env.YUKASSA_REQUEST_TIMEOUT_MS,
      10_000,
      1_000,
      30_000,
    ),
  });
};

const nodeEnv = parseEnum<NodeEnvironment>('NODE_ENV', process.env.NODE_ENV, 'development', [
  'development',
  'test',
  'production',
]);
const refreshCookieSecure = parseBoolean(
  'AUTH_REFRESH_COOKIE_SECURE',
  process.env.AUTH_REFRESH_COOKIE_SECURE,
  nodeEnv === 'production',
);
const refreshCookieSameSite = parseEnum<SameSiteMode>(
  'AUTH_REFRESH_COOKIE_SAME_SITE',
  process.env.AUTH_REFRESH_COOKIE_SAME_SITE,
  'lax',
  ['lax', 'strict', 'none'],
);
const tokenDeliveryMode = parseEnum<TokenDeliveryMode>(
  'AUTH_TOKEN_DELIVERY_MODE',
  process.env.AUTH_TOKEN_DELIVERY_MODE,
  nodeEnv === 'production' ? 'disabled' : 'console',
  ['console', 'disabled'],
);
const phoneLoginEnabled = parseBoolean(
  'AUTH_PHONE_LOGIN_ENABLED',
  process.env.AUTH_PHONE_LOGIN_ENABLED,
  true,
);
const phoneOnlyRegistrationEnabled = parseBoolean(
  'AUTH_PHONE_ONLY_REGISTRATION_ENABLED',
  process.env.AUTH_PHONE_ONLY_REGISTRATION_ENABLED,
  false,
);
const jwtAccessSecret = process.env.JWT_ACCESS_SECRET ?? DEVELOPMENT_ACCESS_SECRET;
const refreshCookieName = process.env.AUTH_REFRESH_COOKIE_NAME?.trim() || 'kinetra_refresh';

if (phoneOnlyRegistrationEnabled && !phoneLoginEnabled) {
  throw new Error('AUTH_PHONE_ONLY_REGISTRATION_ENABLED requires AUTH_PHONE_LOGIN_ENABLED=true.');
}

if (!/^[A-Za-z0-9_-]{1,64}$/u.test(refreshCookieName)) {
  throw new Error('AUTH_REFRESH_COOKIE_NAME contains unsupported characters.');
}

if (refreshCookieSameSite === 'none' && !refreshCookieSecure) {
  throw new Error('SameSite=None requires AUTH_REFRESH_COOKIE_SECURE=true.');
}

if (Buffer.byteLength(jwtAccessSecret, 'utf8') < 32) {
  throw new Error('JWT_ACCESS_SECRET must contain at least 32 UTF-8 bytes.');
}

if (nodeEnv === 'production' && jwtAccessSecret === DEVELOPMENT_ACCESS_SECRET) {
  throw new Error('JWT_ACCESS_SECRET must be replaced before production startup.');
}

if (nodeEnv === 'production' && tokenDeliveryMode === 'console') {
  throw new Error('AUTH_TOKEN_DELIVERY_MODE=console is forbidden in production.');
}

export const env = Object.freeze({
  nodeEnv,
  host: process.env.HOST ?? '0.0.0.0',
  port: parseInteger('PORT', process.env.PORT, 3000, 1, 65_535),
  corsOrigins: parseOrigins(process.env.CORS_ORIGIN),
  trustProxyHops: parseInteger('TRUST_PROXY_HOPS', process.env.TRUST_PROXY_HOPS, 0, 0, 10),
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgresql://kinetra:kinetra_local_only@localhost:5432/kinetra',
  s3: parseS3Environment(nodeEnv),
  yookassa: parseYooKassaEnvironment(nodeEnv),
  auth: Object.freeze({
    jwtAccessSecret,
    jwtAccessTtlSeconds: parseInteger(
      'JWT_ACCESS_TTL_SECONDS',
      process.env.JWT_ACCESS_TTL_SECONDS,
      900,
      60,
      3600,
    ),
    jwtIssuer: process.env.JWT_ISSUER?.trim() || 'kinetra-backend',
    jwtAudience: process.env.JWT_AUDIENCE?.trim() || 'kinetra-pwa',
    bcryptCost: parseInteger('AUTH_BCRYPT_COST', process.env.AUTH_BCRYPT_COST, 12, 10, 15),
    passwordMinimumLength: parseInteger(
      'AUTH_PASSWORD_MIN_LENGTH',
      process.env.AUTH_PASSWORD_MIN_LENGTH,
      10,
      8,
      64,
    ),
    refreshTtlDays: parseInteger(
      'AUTH_REFRESH_TTL_DAYS',
      process.env.AUTH_REFRESH_TTL_DAYS,
      30,
      1,
      365,
    ),
    refreshCookieName,
    refreshCookieSecure,
    refreshCookieSameSite,
    phoneLoginEnabled,
    phoneOnlyRegistrationEnabled,
    emailVerificationRequired: parseBoolean(
      'AUTH_EMAIL_VERIFICATION_REQUIRED',
      process.env.AUTH_EMAIL_VERIFICATION_REQUIRED,
      false,
    ),
    emailVerificationTtlMinutes: parseInteger(
      'AUTH_EMAIL_VERIFICATION_TTL_MINUTES',
      process.env.AUTH_EMAIL_VERIFICATION_TTL_MINUTES,
      1440,
      5,
      10_080,
    ),
    passwordResetTtlMinutes: parseInteger(
      'AUTH_PASSWORD_RESET_TTL_MINUTES',
      process.env.AUTH_PASSWORD_RESET_TTL_MINUTES,
      15,
      5,
      120,
    ),
    passwordResetRateLimitWindowMs: parseInteger(
      'AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS',
      process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS,
      900_000,
      1_000,
      86_400_000,
    ),
    passwordResetRateLimitMax: parseInteger(
      'AUTH_PASSWORD_RESET_RATE_LIMIT_MAX',
      process.env.AUTH_PASSWORD_RESET_RATE_LIMIT_MAX,
      5,
      1,
      100,
    ),
    tokenDeliveryMode,
  }),
});
