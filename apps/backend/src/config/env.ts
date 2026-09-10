import { BlockList, isIP } from 'node:net';
import { parseDatabaseUrl, parseNodeEnvironment, type NodeEnvironment } from './database.js';
import { parseFreeBetaEnabled, parsePaymentsEnabled } from './payments.js';
export { parseDatabaseUrl } from './database.js';

type SameSiteMode = 'lax' | 'strict' | 'none';
type TokenDeliveryMode = 'console' | 'disabled' | 'webhook' | 'smtp';

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

export interface VapidEnvironment {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
}

export interface ChatPhotoUploadTimeoutEnvironment {
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export interface VideoUploadsEnvironment {
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly partSizeBytes: number;
  readonly partUrlTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly maxActivePerTrainer: number;
  readonly ffprobePath: string;
  readonly verifyLeaseSeconds: number;
  readonly verifyDeadlineSeconds: number;
  readonly verifyMaxAttempts: number;
  readonly workerMaxStaleSeconds: number;
  readonly deleteGraceSeconds: number;
  readonly serverSideEncryption: 'AES256' | 'aws:kms';
  readonly kmsKeyId: string | null;
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

export const parseChatPhotoUploadTimeouts = (
  idleSecondsValue: string | undefined,
  totalSecondsValue: string | undefined,
): Readonly<ChatPhotoUploadTimeoutEnvironment> => {
  const idleSeconds = parseInteger(
    'CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_SECONDS',
    idleSecondsValue,
    15,
    1,
    30,
  );
  const totalSeconds = parseInteger(
    'CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_SECONDS',
    totalSecondsValue,
    120,
    10,
    120,
  );

  if (idleSeconds >= totalSeconds) {
    throw new Error(
      'CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_SECONDS must be less than CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_SECONDS.',
    );
  }

  return Object.freeze({
    idleTimeoutMs: idleSeconds * 1000,
    totalTimeoutMs: totalSeconds * 1000,
  });
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

export const parseCorsOrigins = (
  rawValue: string | undefined,
  nodeEnvironment: NodeEnvironment = 'development',
): readonly string[] => {
  const entries = (rawValue ?? 'http://localhost:5173').split(',').map((origin) => origin.trim());

  if (entries.length === 0 || entries.some((origin) => origin.length === 0)) {
    throw new Error('CORS_ORIGIN must contain at least one origin.');
  }

  const normalized = entries.map((origin) => {
    let parsed: URL;

    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('CORS_ORIGIN entries must be exact HTTP or HTTPS origins.');
    }

    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin === 'null' ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error('CORS_ORIGIN entries must be exact HTTP or HTTPS origins.');
    }

    if (nodeEnvironment === 'production' && parsed.protocol !== 'https:') {
      throw new Error('CORS_ORIGIN entries must use HTTPS in production.');
    }

    return parsed.origin;
  });

  return Object.freeze([...new Set(normalized)]);
};

const trimmedOrNull = (rawValue: string | undefined): string | null => {
  const value = rawValue?.trim();
  return value === undefined || value.length === 0 ? null : value;
};

export const parseVideoUploadsEnvironment = (
  values: NodeJS.ProcessEnv,
): Readonly<VideoUploadsEnvironment> => {
  const serverSideEncryption = parseEnum<'AES256' | 'aws:kms'>(
    'VIDEO_S3_SERVER_SIDE_ENCRYPTION',
    values.VIDEO_S3_SERVER_SIDE_ENCRYPTION,
    'AES256',
    ['AES256', 'aws:kms'],
  );
  const kmsKeyId = trimmedOrNull(values.VIDEO_S3_KMS_KEY_ID);
  const ffprobePath = trimmedOrNull(values.VIDEO_VERIFY_FFPROBE_PATH) ?? 'ffprobe';

  if (serverSideEncryption === 'aws:kms' && kmsKeyId === null) {
    throw new Error(
      'VIDEO_S3_KMS_KEY_ID is required when VIDEO_S3_SERVER_SIDE_ENCRYPTION=aws:kms.',
    );
  }
  if (serverSideEncryption !== 'aws:kms' && kmsKeyId !== null) {
    throw new Error(
      'VIDEO_S3_KMS_KEY_ID is only valid with VIDEO_S3_SERVER_SIDE_ENCRYPTION=aws:kms.',
    );
  }
  if (ffprobePath.length > 1024 || ffprobePath.includes('\0')) {
    throw new Error('VIDEO_VERIFY_FFPROBE_PATH is invalid.');
  }

  const partSizeBytes = parseInteger(
    'VIDEO_UPLOAD_PART_SIZE_BYTES',
    values.VIDEO_UPLOAD_PART_SIZE_BYTES,
    16_777_216,
    5_242_880,
    67_108_864,
  );
  const maxBytes = parseInteger(
    'VIDEO_UPLOAD_MAX_BYTES',
    values.VIDEO_UPLOAD_MAX_BYTES,
    2_147_483_648,
    1,
    2_147_483_648,
  );

  if (Math.ceil(maxBytes / partSizeBytes) > 10_000) {
    throw new Error('VIDEO_UPLOAD_MAX_BYTES and VIDEO_UPLOAD_PART_SIZE_BYTES exceed 10000 parts.');
  }

  return Object.freeze({
    enabled: parseBoolean(
      'TRAINER_VIDEO_UPLOADS_ENABLED',
      values.TRAINER_VIDEO_UPLOADS_ENABLED,
      false,
    ),
    maxBytes,
    partSizeBytes,
    partUrlTtlSeconds: parseInteger(
      'VIDEO_UPLOAD_PART_URL_TTL_SECONDS',
      values.VIDEO_UPLOAD_PART_URL_TTL_SECONDS,
      900,
      60,
      900,
    ),
    sessionTtlSeconds: parseInteger(
      'VIDEO_UPLOAD_SESSION_TTL_SECONDS',
      values.VIDEO_UPLOAD_SESSION_TTL_SECONDS,
      21_600,
      900,
      86_400,
    ),
    maxActivePerTrainer: parseInteger(
      'VIDEO_UPLOAD_MAX_ACTIVE_PER_TRAINER',
      values.VIDEO_UPLOAD_MAX_ACTIVE_PER_TRAINER,
      3,
      1,
      10,
    ),
    ffprobePath,
    verifyLeaseSeconds: parseInteger(
      'VIDEO_VERIFY_LEASE_SECONDS',
      values.VIDEO_VERIFY_LEASE_SECONDS,
      300,
      30,
      1800,
    ),
    verifyDeadlineSeconds: parseInteger(
      'VIDEO_VERIFY_DEADLINE_SECONDS',
      values.VIDEO_VERIFY_DEADLINE_SECONDS,
      900,
      30,
      3600,
    ),
    verifyMaxAttempts: parseInteger(
      'VIDEO_VERIFY_MAX_ATTEMPTS',
      values.VIDEO_VERIFY_MAX_ATTEMPTS,
      8,
      1,
      100,
    ),
    workerMaxStaleSeconds: parseInteger(
      'VIDEO_WORKER_MAX_STALE_SECONDS',
      values.VIDEO_WORKER_MAX_STALE_SECONDS,
      300,
      30,
      3600,
    ),
    deleteGraceSeconds: parseInteger(
      'VIDEO_MEDIA_DELETE_GRACE_SECONDS',
      values.VIDEO_MEDIA_DELETE_GRACE_SECONDS,
      86_400,
      86_400,
      604_800,
    ),
    serverSideEncryption,
    kmsKeyId,
  });
};

export const parseS3Environment = (
  nodeEnvironment: NodeEnvironment,
  values: NodeJS.ProcessEnv = process.env,
): Readonly<S3Environment> | null => {
  const endpoint = trimmedOrNull(values.S3_ENDPOINT);
  const region = trimmedOrNull(values.S3_REGION);
  const bucket = trimmedOrNull(values.S3_BUCKET);
  const accessKeyId = trimmedOrNull(values.S3_ACCESS_KEY_ID);
  const secretAccessKey = trimmedOrNull(values.S3_SECRET_ACCESS_KEY);
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

    if (
      !['http:', 'https:'].includes(parsedEndpoint.protocol) ||
      parsedEndpoint.username ||
      parsedEndpoint.password ||
      parsedEndpoint.pathname !== '/' ||
      parsedEndpoint.search ||
      parsedEndpoint.hash
    ) {
      throw new Error('S3_ENDPOINT must be a valid HTTP or HTTPS URL.');
    }

    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsedEndpoint.hostname);
    if (parsedEndpoint.protocol !== 'https:' && (nodeEnvironment === 'production' || !loopback)) {
      throw new Error('S3_ENDPOINT must use HTTPS outside explicit loopback development or tests.');
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
      values.S3_FORCE_PATH_STYLE,
      endpoint !== null,
    ),
    presignedUrlTtlSeconds: parseInteger(
      'S3_PRESIGNED_URL_TTL_SECONDS',
      values.S3_PRESIGNED_URL_TTL_SECONDS,
      900,
      60,
      86_400,
    ),
  });
};

export const parseYooKassaEnvironment = (
  nodeEnvironment: NodeEnvironment,
  values: NodeJS.ProcessEnv = process.env,
): Readonly<YooKassaEnvironment> | null => {
  const shopId = trimmedOrNull(values.YUKASSA_SHOP_ID);
  const secretKey = trimmedOrNull(values.YUKASSA_SECRET_KEY);

  if (!parsePaymentsEnabled(values.PAYMENTS_ENABLED)) {
    if (shopId !== null || secretKey !== null) {
      throw new Error('YooKassa credentials must be empty when PAYMENTS_ENABLED=false.');
    }
    return null;
  }

  if (shopId === null && secretKey === null) {
    if (nodeEnvironment === 'production') {
      throw new Error('YUKASSA_SHOP_ID and YUKASSA_SECRET_KEY are required in production.');
    }

    return null;
  }

  if (shopId === null || secretKey === null) {
    throw new Error('YooKassa configuration is incomplete. Set both shop ID and secret key.');
  }

  const rawReturnUrls = values.YUKASSA_RETURN_URL ?? 'http://localhost:5173/payment/success';
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
      values.YUKASSA_REQUEST_TIMEOUT_MS,
      10_000,
      1_000,
      30_000,
    ),
  });
};

const parseVapidEnvironment = (
  nodeEnvironment: NodeEnvironment,
): Readonly<VapidEnvironment> | null => {
  const publicKey = trimmedOrNull(process.env.VAPID_PUBLIC_KEY);
  const privateKey = trimmedOrNull(process.env.VAPID_PRIVATE_KEY);
  const subject = trimmedOrNull(process.env.VAPID_SUBJECT);

  if (publicKey === null && privateKey === null && subject === null) {
    if (nodeEnvironment === 'production') {
      throw new Error(
        'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are required in production.',
      );
    }

    return null;
  }

  if (publicKey === null || privateKey === null || subject === null) {
    throw new Error(
      'Web Push configuration is incomplete. Set public key, private key and subject.',
    );
  }

  if (!/^[A-Za-z0-9_-]{80,128}$/u.test(publicKey)) {
    throw new Error('VAPID_PUBLIC_KEY must be a valid base64url public key.');
  }

  if (!/^[A-Za-z0-9_-]{40,128}$/u.test(privateKey)) {
    throw new Error('VAPID_PRIVATE_KEY must be a valid base64url private key.');
  }

  let subjectUrl: URL;

  try {
    subjectUrl = new URL(subject);
  } catch {
    throw new Error('VAPID_SUBJECT must be a valid mailto: or HTTPS URL.');
  }

  if (!['mailto:', 'https:'].includes(subjectUrl.protocol)) {
    throw new Error('VAPID_SUBJECT must use mailto: or HTTPS.');
  }

  return Object.freeze({ publicKey, privateKey, subject });
};

export interface TokenDeliveryWebhookEnvironment {
  readonly url: string;
  readonly secret: string;
  readonly timeoutMs: number;
}

export interface TokenDeliverySmtpEnvironment {
  readonly service: 'yandex' | 'gmail';
  readonly username: string;
  readonly password: string;
  readonly appOrigin: string;
  readonly timeoutMs: number;
}

const smtpKeys = [
  'AUTH_TOKEN_DELIVERY_SMTP_SERVICE',
  'AUTH_TOKEN_DELIVERY_SMTP_USERNAME',
  'AUTH_TOKEN_DELIVERY_SMTP_PASSWORD',
  'AUTH_TOKEN_DELIVERY_APP_ORIGIN',
] as const;

const rejectUnusedDeliveryValues = (values: NodeJS.ProcessEnv, keys: readonly string[]) => {
  if (keys.some((key) => values[key] !== undefined && values[key] !== '')) {
    throw new Error('AUTH_TOKEN_DELIVERY_MODE must not mix webhook and SMTP configuration.');
  }
};

const isPublicAppHost = (hostname: string): boolean => {
  const host = hostname.replace(/^\[|\]$/gu, '');
  const family = isIP(host);
  if (family === 4) {
    const blocked = new BlockList();
    for (const [network, prefix] of [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['198.18.0.0', 15],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ] as const)
      blocked.addSubnet(network, prefix, 'ipv4');
    return !blocked.check(host, 'ipv4');
  }
  if (family === 6) {
    const global = new BlockList();
    global.addSubnet('2000::', 3, 'ipv6');
    return global.check(host, 'ipv6') && !/^2001:(?:db8|0):|^2002:|^3fff:/u.test(host);
  }
  return (
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(host) &&
    !/\.(?:localhost|local|internal|home|lan)$/u.test(host)
  );
};

export const parseTokenDeliverySmtp = (
  values: NodeJS.ProcessEnv,
  corsOrigins: readonly string[],
): Readonly<TokenDeliverySmtpEnvironment> => {
  rejectUnusedDeliveryValues(values, [
    'AUTH_TOKEN_DELIVERY_WEBHOOK_URL',
    'AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET',
  ]);
  const service = values.AUTH_TOKEN_DELIVERY_SMTP_SERVICE;
  if (service !== 'yandex' && service !== 'gmail') {
    throw new Error('AUTH_TOKEN_DELIVERY_SMTP_SERVICE must be yandex or gmail.');
  }
  const username = values.AUTH_TOKEN_DELIVERY_SMTP_USERNAME ?? '';
  const [localPart = '', domain = '', ...extra] = username.split('@');
  if (
    username.length > 254 ||
    localPart.length > 64 ||
    extra.length > 0 ||
    !/^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*$/u.test(localPart) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u.test(
      domain,
    )
  ) {
    throw new Error('AUTH_TOKEN_DELIVERY_SMTP_USERNAME must be one full email address.');
  }
  const password = values.AUTH_TOKEN_DELIVERY_SMTP_PASSWORD ?? '';
  if (!/^[\x21-\x7e]{16,256}$/u.test(password)) {
    throw new Error(
      'AUTH_TOKEN_DELIVERY_SMTP_PASSWORD must contain 16-256 printable non-space ASCII characters.',
    );
  }
  const appOrigin = values.AUTH_TOKEN_DELIVERY_APP_ORIGIN ?? '';
  let url: URL;
  try {
    url = new URL(appOrigin);
  } catch {
    throw new Error(
      'AUTH_TOKEN_DELIVERY_APP_ORIGIN must be an exact public HTTPS origin from CORS_ORIGIN.',
    );
  }
  if (
    appOrigin.length > 2048 ||
    url.protocol !== 'https:' ||
    appOrigin !== url.origin ||
    !isPublicAppHost(url.hostname) ||
    !corsOrigins.includes(appOrigin)
  ) {
    throw new Error(
      'AUTH_TOKEN_DELIVERY_APP_ORIGIN must be an exact public HTTPS origin from CORS_ORIGIN.',
    );
  }
  return Object.freeze({
    service,
    username,
    password,
    appOrigin,
    timeoutMs: parseInteger(
      'AUTH_TOKEN_DELIVERY_TIMEOUT_MS',
      values.AUTH_TOKEN_DELIVERY_TIMEOUT_MS,
      10000,
      1000,
      30000,
    ),
  });
};

export const parseTokenDeliveryWebhook = (
  values: NodeJS.ProcessEnv,
): Readonly<TokenDeliveryWebhookEnvironment> => {
  rejectUnusedDeliveryValues(values, smtpKeys);
  const rawUrl = values.AUTH_TOKEN_DELIVERY_WEBHOOK_URL ?? '';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('AUTH_TOKEN_DELIVERY_WEBHOOK_URL must be an HTTPS URL.');
  }
  if (
    rawUrl.length > 2048 ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'AUTH_TOKEN_DELIVERY_WEBHOOK_URL must use HTTPS without credentials, query or fragment.',
    );
  }
  const secret = values.AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET ?? '';
  if (!/^[\x21-\x7e]{32,512}$/u.test(secret)) {
    throw new Error(
      'AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET must contain 32-512 printable non-space ASCII characters.',
    );
  }
  return Object.freeze({
    url: url.toString(),
    secret,
    timeoutMs: parseInteger(
      'AUTH_TOKEN_DELIVERY_TIMEOUT_MS',
      values.AUTH_TOKEN_DELIVERY_TIMEOUT_MS,
      10000,
      1000,
      30000,
    ),
  });
};

export const parseShutdownEnvironment = (
  values: NodeJS.ProcessEnv,
): Readonly<{ drainMs: number; timeoutMs: number }> => {
  const drainMs = parseInteger('SHUTDOWN_DRAIN_MS', values.SHUTDOWN_DRAIN_MS, 5000, 0, 30000);
  const timeoutMs = parseInteger(
    'SHUTDOWN_TIMEOUT_MS',
    values.SHUTDOWN_TIMEOUT_MS,
    25000,
    1000,
    120000,
  );
  if (drainMs >= timeoutMs)
    throw new Error('SHUTDOWN_DRAIN_MS must be less than SHUTDOWN_TIMEOUT_MS.');
  return Object.freeze({ drainMs, timeoutMs });
};

const nodeEnv = parseNodeEnvironment(process.env.NODE_ENV);
const paymentsEnabled = parsePaymentsEnabled(process.env.PAYMENTS_ENABLED);
const freeBetaEnabled = parseFreeBetaEnabled(process.env.FREE_BETA_ENABLED, paymentsEnabled);
const s3 = parseS3Environment(nodeEnv);
const videoUploads = parseVideoUploadsEnvironment(process.env);
const chatEnabled = parseBoolean('CHAT_ENABLED', process.env.CHAT_ENABLED, false);
const chatPhotoUploadsEnabled = parseBoolean(
  'CHAT_PHOTO_UPLOADS_ENABLED',
  process.env.CHAT_PHOTO_UPLOADS_ENABLED,
  false,
);
const chatPhotoUploadTimeouts = parseChatPhotoUploadTimeouts(
  process.env.CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_SECONDS,
  process.env.CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_SECONDS,
);

if (chatPhotoUploadsEnabled && !chatEnabled) {
  throw new Error('CHAT_PHOTO_UPLOADS_ENABLED=true requires CHAT_ENABLED=true.');
}

if (chatPhotoUploadsEnabled && s3 === null) {
  throw new Error('CHAT_PHOTO_UPLOADS_ENABLED=true requires complete private S3 configuration.');
}
if (videoUploads.enabled && s3 === null) {
  throw new Error('TRAINER_VIDEO_UPLOADS_ENABLED=true requires complete private S3 configuration.');
}
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
  nodeEnv === 'production' ? 'webhook' : 'console',
  ['console', 'disabled', 'webhook', 'smtp'],
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

if (nodeEnv === 'production' && !['webhook', 'smtp'].includes(tokenDeliveryMode)) {
  throw new Error('AUTH_TOKEN_DELIVERY_MODE=webhook or smtp is required in production.');
}
if (nodeEnv === 'production' && !refreshCookieSecure) {
  throw new Error('AUTH_REFRESH_COOKIE_SECURE=true is required in production.');
}
const tokenDeliveryWebhook =
  tokenDeliveryMode === 'webhook' ? parseTokenDeliveryWebhook(process.env) : null;
const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGIN, nodeEnv);
const tokenDeliverySmtp =
  tokenDeliveryMode === 'smtp' ? parseTokenDeliverySmtp(process.env, corsOrigins) : null;
const shutdown = parseShutdownEnvironment(process.env);

export const env = Object.freeze({
  nodeEnv,
  host: process.env.HOST ?? '0.0.0.0',
  port: parseInteger('PORT', process.env.PORT, 3000, 1, 65_535),
  corsOrigins,
  trustProxyHops: parseInteger('TRUST_PROXY_HOPS', process.env.TRUST_PROXY_HOPS, 0, 0, 10),
  databaseUrl: parseDatabaseUrl(nodeEnv, process.env.DATABASE_URL),
  readinessTimeoutMs: parseInteger(
    'READINESS_TIMEOUT_MS',
    process.env.READINESS_TIMEOUT_MS,
    2000,
    100,
    5000,
  ),
  shutdown,
  s3,
  videoUploads,
  paymentsEnabled,
  freeBetaEnabled,
  yookassa: parseYooKassaEnvironment(nodeEnv),
  vapid: parseVapidEnvironment(nodeEnv),
  chat: Object.freeze({
    enabled: chatEnabled,
    photoUploadsEnabled: chatPhotoUploadsEnabled,
    photoUploadIdleTimeoutMs: chatPhotoUploadTimeouts.idleTimeoutMs,
    photoUploadTotalTimeoutMs: chatPhotoUploadTimeouts.totalTimeoutMs,
    mediaUrlTtlSeconds: parseInteger(
      'CHAT_MEDIA_URL_TTL_SECONDS',
      process.env.CHAT_MEDIA_URL_TTL_SECONDS,
      300,
      60,
      900,
    ),
  }),
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
    tokenDeliveryWebhook,
    tokenDeliverySmtp,
  }),
});
