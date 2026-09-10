import { readFileSync, statSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mainKeys = [
  'NODE_IMAGE',
  'NGINX_IMAGE',
  'BACKEND_IMAGE',
  'FRONTEND_IMAGE',
  'VCS_REF',
  'VITE_API_URL',
  'VITE_PRIVATE_MEDIA_ORIGIN',
  'KINETRA_API_ENV_FILE',
  'KINETRA_VIDEO_SCRATCH_DIR',
];
const apiKeys = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'CORS_ORIGIN',
  'TRUST_PROXY_HOPS',
  'READINESS_TIMEOUT_MS',
  'SHUTDOWN_DRAIN_MS',
  'SHUTDOWN_TIMEOUT_MS',
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_ACCESS_TTL_SECONDS',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'AUTH_BCRYPT_COST',
  'AUTH_PASSWORD_MIN_LENGTH',
  'AUTH_REFRESH_TTL_DAYS',
  'AUTH_REFRESH_COOKIE_NAME',
  'AUTH_REFRESH_COOKIE_SECURE',
  'AUTH_REFRESH_COOKIE_SAME_SITE',
  'AUTH_PHONE_LOGIN_ENABLED',
  'AUTH_PHONE_ONLY_REGISTRATION_ENABLED',
  'AUTH_EMAIL_VERIFICATION_REQUIRED',
  'AUTH_EMAIL_VERIFICATION_TTL_MINUTES',
  'AUTH_PASSWORD_RESET_TTL_MINUTES',
  'AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_MS',
  'AUTH_PASSWORD_RESET_RATE_LIMIT_MAX',
  'AUTH_TOKEN_DELIVERY_MODE',
  'AUTH_TOKEN_DELIVERY_WEBHOOK_URL',
  'AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET',
  'AUTH_TOKEN_DELIVERY_TIMEOUT_MS',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
  'S3_PRESIGNED_URL_TTL_SECONDS',
  'TRAINER_VIDEO_UPLOADS_ENABLED',
  'VIDEO_UPLOAD_MAX_BYTES',
  'VIDEO_UPLOAD_PART_SIZE_BYTES',
  'VIDEO_UPLOAD_PART_URL_TTL_SECONDS',
  'VIDEO_UPLOAD_SESSION_TTL_SECONDS',
  'VIDEO_UPLOAD_MAX_ACTIVE_PER_TRAINER',
  'VIDEO_VERIFY_FFPROBE_PATH',
  'VIDEO_VERIFY_LEASE_SECONDS',
  'VIDEO_VERIFY_DEADLINE_SECONDS',
  'VIDEO_VERIFY_MAX_ATTEMPTS',
  'VIDEO_WORKER_MAX_STALE_SECONDS',
  'VIDEO_MEDIA_DELETE_GRACE_SECONDS',
  'VIDEO_S3_SERVER_SIDE_ENCRYPTION',
  'VIDEO_S3_KMS_KEY_ID',
  'CHAT_ENABLED',
  'CHAT_PHOTO_UPLOADS_ENABLED',
  'CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_SECONDS',
  'CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_SECONDS',
  'CHAT_MEDIA_URL_TTL_SECONDS',
  'YUKASSA_SHOP_ID',
  'PAYMENTS_ENABLED',
  'YUKASSA_SECRET_KEY',
  'YUKASSA_RETURN_URL',
  'YUKASSA_REQUEST_TIMEOUT_MS',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
];
const s3Keys = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
];
const videoKeys = [
  'TRAINER_VIDEO_UPLOADS_ENABLED',
  'VIDEO_VERIFY_FFPROBE_PATH',
  'VIDEO_VERIFY_LEASE_SECONDS',
  'VIDEO_VERIFY_DEADLINE_SECONDS',
  'VIDEO_VERIFY_MAX_ATTEMPTS',
  'VIDEO_MEDIA_DELETE_GRACE_SECONDS',
  'VIDEO_S3_SERVER_SIDE_ENCRYPTION',
  'VIDEO_S3_KMS_KEY_ID',
];
export const jobKeys = {
  migrate: [],
  notifications: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
  renewals: [
    'PAYMENTS_ENABLED',
    'YUKASSA_SHOP_ID',
    'YUKASSA_SECRET_KEY',
    'YUKASSA_REQUEST_TIMEOUT_MS',
  ],
  'chat-cleanup': s3Keys,
  'video-cleanup': s3Keys,
  'video-verify': [...s3Keys, ...videoKeys],
};
const badValue =
  /REPLACE|CHANGE_ME|CHANGEME|example\.(invalid|com)|local-development-only|kinetra_local_only/i;
const isLocalHost = (host) => {
  let canonical;
  try {
    canonical = new URL(`http://${host}`).hostname;
  } catch {
    return true;
  }
  const name = canonical.toLowerCase().replace(/\.$/, '');
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    /^127\./.test(name) ||
    /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(name) ||
    ['0.0.0.0', '[::]', '[::1]', '[::ffff:0:0]'].includes(name)
  );
};
const fail = (name) => {
  throw new Error(`Invalid production configuration: ${name}.`);
};

export function readEnvironment(path, privateFile = false) {
  if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile())
    fail('absolute regular environment file required');
  if (privateFile && (statSync(path).mode & 0o077) !== 0)
    fail('secret environment file must have mode 0600');
  const result = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (
      !match ||
      Object.hasOwn(result, match[1]) ||
      /[\x00-\x1f\x7f$'"`]/.test(match[2]) ||
      match[2] !== match[2].trim()
    )
      fail('raw KEY=VALUE syntax, duplicates or interpolation');
    result[match[1]] = match[2];
  }
  return result;
}
function required(values, name) {
  const value = values[name];
  if (!value || badValue.test(value)) fail(name);
  return value;
}
function exactKeys(values, allowed) {
  for (const key of Object.keys(values)) if (!allowed.includes(key)) fail(`unexpected key ${key}`);
}
function https(value, name, origin = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(name);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    isLocalHost(url.hostname) ||
    (origin && url.pathname !== '/')
  )
    fail(name);
  return url;
}
function integer(values, name, min, max) {
  const raw = required(values, name);
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) fail(name);
}
function database(values) {
  if (values.NODE_ENV !== 'production') fail('NODE_ENV');
  let url;
  try {
    url = new URL(required(values, 'DATABASE_URL'));
  } catch {
    fail('DATABASE_URL');
  }
  let username;
  let password;
  try {
    username = decodeURIComponent(url.username).trim();
    password = decodeURIComponent(url.password).trim();
  } catch {
    fail('DATABASE_URL credentials');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !username ||
    !password ||
    password === 'kinetra_local_only' ||
    !url.hostname ||
    isLocalHost(url.hostname) ||
    url.pathname.length < 2 ||
    url.hash ||
    url.searchParams.getAll('sslmode').length !== 1 ||
    !['require', 'verify-full'].includes(url.searchParams.get('sslmode')) ||
    [...url.searchParams.keys()].some((name) => name !== 'sslmode')
  )
    fail('DATABASE_URL TLS/credentials/host');
}
function s3(values) {
  for (const key of s3Keys) required(values, key);
  https(values.S3_ENDPOINT, 'S3_ENDPOINT', true);
  if (!['true', 'false'].includes(values.S3_FORCE_PATH_STYLE)) fail('S3_FORCE_PATH_STYLE');
}
function vapid(values) {
  for (const key of jobKeys.notifications) required(values, key);
  if (
    !/^[A-Za-z0-9_-]{80,128}$/.test(values.VAPID_PUBLIC_KEY) ||
    !/^[A-Za-z0-9_-]{40,128}$/.test(values.VAPID_PRIVATE_KEY)
  )
    fail('VAPID keys');
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(values.VAPID_SUBJECT))
    https(values.VAPID_SUBJECT, 'VAPID_SUBJECT');
}
function payments(values) {
  required(values, 'YUKASSA_SHOP_ID');
  required(values, 'YUKASSA_SECRET_KEY');
  integer(values, 'YUKASSA_REQUEST_TIMEOUT_MS', 1000, 30000);
}
function paymentsEnabled(values) {
  const value = values.PAYMENTS_ENABLED ?? 'true';
  if (!['true', 'false'].includes(value)) fail('PAYMENTS_ENABLED');
  return value === 'true';
}
export function validateMain(values) {
  exactKeys(values, mainKeys);
  for (const key of ['NODE_IMAGE', 'NGINX_IMAGE', 'BACKEND_IMAGE', 'FRONTEND_IMAGE']) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(required(values, key)))
      fail(key);
  }
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(required(values, 'VCS_REF'))) fail('VCS_REF');
  https(required(values, 'VITE_API_URL'), 'VITE_API_URL', true);
  if (values.VITE_PRIVATE_MEDIA_ORIGIN)
    https(required(values, 'VITE_PRIVATE_MEDIA_ORIGIN'), 'VITE_PRIVATE_MEDIA_ORIGIN', true);
  if (!isAbsolute(required(values, 'KINETRA_API_ENV_FILE'))) fail('KINETRA_API_ENV_FILE');
}
export function validateApi(values, main) {
  exactKeys(values, apiKeys);
  database(values);
  if (values.HOST !== '0.0.0.0' || values.PORT !== '3000' || values.TRUST_PROXY_HOPS !== '1')
    fail('compose HOST/PORT/TRUST_PROXY_HOPS');
  for (const origin of required(values, 'CORS_ORIGIN').split(','))
    https(origin, 'CORS_ORIGIN', true);
  for (const key of ['JWT_ACCESS_SECRET', 'AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET'])
    if (!/^[!-~]{32,512}$/.test(required(values, key))) fail(key);
  if (values.AUTH_REFRESH_COOKIE_SECURE !== 'true' || values.AUTH_TOKEN_DELIVERY_MODE !== 'webhook')
    fail('auth delivery/cookie');
  https(required(values, 'AUTH_TOKEN_DELIVERY_WEBHOOK_URL'), 'AUTH_TOKEN_DELIVERY_WEBHOOK_URL');
  integer(values, 'AUTH_TOKEN_DELIVERY_TIMEOUT_MS', 1000, 30000);
  if (paymentsEnabled(values)) {
    payments(values);
    for (const url of required(values, 'YUKASSA_RETURN_URL').split(','))
      https(url, 'YUKASSA_RETURN_URL');
  } else {
    for (const key of ['YUKASSA_SHOP_ID', 'YUKASSA_SECRET_KEY'])
      if (values[key]) fail('YooKassa credentials must be empty when payments are disabled');
  }
  vapid(values);
  for (const name of [
    'CHAT_ENABLED',
    'CHAT_PHOTO_UPLOADS_ENABLED',
    'TRAINER_VIDEO_UPLOADS_ENABLED',
  ])
    if (!['true', 'false'].includes(values[name])) fail(name);
  if (values.CHAT_PHOTO_UPLOADS_ENABLED === 'true' && values.CHAT_ENABLED !== 'true')
    fail('chat photos require chat');
  if (
    s3Keys.slice(0, 5).some((key) => values[key]) ||
    values.CHAT_PHOTO_UPLOADS_ENABLED === 'true' ||
    values.TRAINER_VIDEO_UPLOADS_ENABLED === 'true'
  ) {
    s3(values);
    https(required(main, 'VITE_PRIVATE_MEDIA_ORIGIN'), 'VITE_PRIVATE_MEDIA_ORIGIN', true);
  }
  integer(values, 'READINESS_TIMEOUT_MS', 100, 5000);
  integer(values, 'SHUTDOWN_DRAIN_MS', 0, 30000);
  integer(values, 'SHUTDOWN_TIMEOUT_MS', 1000, 30000);
  if (Number(values.SHUTDOWN_DRAIN_MS) >= Number(values.SHUTDOWN_TIMEOUT_MS))
    fail('shutdown deadline must exceed drain');
}
export function validateJob(values, name) {
  if (!Object.hasOwn(jobKeys, name)) fail('job name');
  exactKeys(values, ['NODE_ENV', 'DATABASE_URL', ...jobKeys[name]]);
  database(values);
  if (name === 'notifications') vapid(values);
  if (name === 'renewals') {
    if (!paymentsEnabled(values)) fail('renewals are disabled');
    payments(values);
  }
  if (name.includes('cleanup') || name === 'video-verify') s3(values);
  if (name === 'video-verify') {
    if (
      values.TRAINER_VIDEO_UPLOADS_ENABLED !== 'true' ||
      values.VIDEO_VERIFY_FFPROBE_PATH !== '/usr/bin/ffprobe'
    )
      fail('video verifier flag/path');
    integer(values, 'VIDEO_VERIFY_LEASE_SECONDS', 30, 1800);
    integer(values, 'VIDEO_VERIFY_DEADLINE_SECONDS', 30, 900);
    integer(values, 'VIDEO_VERIFY_MAX_ATTEMPTS', 1, 100);
    integer(values, 'VIDEO_MEDIA_DELETE_GRACE_SECONDS', 86400, 604800);
    if (!['AES256', 'aws:kms'].includes(values.VIDEO_S3_SERVER_SIDE_ENCRYPTION))
      fail('video encryption');
    if (values.VIDEO_S3_SERVER_SIDE_ENCRYPTION === 'aws:kms')
      required(values, 'VIDEO_S3_KMS_KEY_ID');
    else if (values.VIDEO_S3_KMS_KEY_ID) fail('KMS key only permitted with aws:kms');
  }
}
function validateScratch(main) {
  const path = required(main, 'KINETRA_VIDEO_SCRATCH_DIR');
  if (!isAbsolute(path) || path === '/tmp' || lstatSync(path).isSymbolicLink())
    fail('dedicated video scratch');
  const stats = statSync(path);
  if (!stats.isDirectory() || stats.uid !== 1000 || (stats.mode & 0o777) !== 0o700)
    fail('video scratch must be UID1000 mode0700');
  // Encryption and disk capacity require separate infrastructure evidence.
}
export function validateFiles(mainFile, name, jobFile) {
  const main = readEnvironment(mainFile);
  validateMain(main);
  if (name) {
    if (!jobFile) fail('job environment file');
    validateJob(readEnvironment(jobFile, true), name);
    if (name === 'video-verify') validateScratch(main);
  } else validateApi(readEnvironment(main.KINETRA_API_ENV_FILE, true), main);
  return main;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 && process.argv.length !== 5)
      fail(
        'usage: node ops/validate-production-env.mjs /absolute/production.env [job /absolute/job.env]',
      );
    validateFiles(process.argv[2], process.argv[3], process.argv[4]);
    console.log('KINETRA_PRODUCTION_ENV=PASS (configuration only; no services contacted)');
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith('Invalid production configuration:')
        ? error.message
        : 'Production environment validation failed; check file paths and permissions.',
    );
    process.exitCode = 1;
  }
}
