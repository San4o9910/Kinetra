import { parseDatabaseUrl, parseNodeEnvironment } from './database.js';
import type { S3Environment, VapidEnvironment, VideoUploadsEnvironment } from './env.js';

export type JobS3Environment = Omit<S3Environment, 'presignedUrlTtlSeconds'>;
export type VideoVerificationEnvironment = Pick<
  VideoUploadsEnvironment,
  | 'ffprobePath'
  | 'verifyLeaseSeconds'
  | 'verifyDeadlineSeconds'
  | 'verifyMaxAttempts'
  | 'deleteGraceSeconds'
  | 'serverSideEncryption'
  | 'kmsKeyId'
>;

const required = (values: NodeJS.ProcessEnv, key: string): string => {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${key} is required for this job.`);
  return value;
};
const integer = (
  values: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const value = Number(values[key] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${key} is out of range.`);
  return value;
};
const common = (values: NodeJS.ProcessEnv) => {
  const nodeEnv = parseNodeEnvironment(values.NODE_ENV);
  return { nodeEnv, databaseUrl: parseDatabaseUrl(nodeEnv, values.DATABASE_URL) };
};
const s3 = (values: NodeJS.ProcessEnv): Readonly<JobS3Environment> => {
  const endpoint = values.S3_ENDPOINT?.trim() || null;
  const region = required(values, 'S3_REGION');
  const bucket = required(values, 'S3_BUCKET');
  const accessKeyId = required(values, 'S3_ACCESS_KEY_ID');
  const secretAccessKey = required(values, 'S3_SECRET_ACCESS_KEY');
  if (endpoint !== null) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('S3_ENDPOINT is invalid.');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && values.NODE_ENV !== 'production' && loopback))
    ) {
      throw new Error('S3_ENDPOINT requires HTTPS outside loopback tests and must be an origin.');
    }
  }
  const rawPathStyle = (values.S3_FORCE_PATH_STYLE ?? String(endpoint !== null))
    .trim()
    .toLowerCase();
  if (!['true', 'false'].includes(rawPathStyle))
    throw new Error('S3_FORCE_PATH_STYLE must be true or false.');
  return Object.freeze({
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: rawPathStyle === 'true',
  });
};

export const parseNotificationJobEnvironment = (values: NodeJS.ProcessEnv = process.env) => {
  const base = common(values);
  const publicKey = required(values, 'VAPID_PUBLIC_KEY');
  const privateKey = required(values, 'VAPID_PRIVATE_KEY');
  const subject = required(values, 'VAPID_SUBJECT');
  let subjectUrl: URL;
  try {
    subjectUrl = new URL(subject);
  } catch {
    throw new Error('VAPID_SUBJECT is invalid.');
  }
  if (
    !/^[A-Za-z0-9_-]{80,128}$/u.test(publicKey) ||
    !/^[A-Za-z0-9_-]{40,128}$/u.test(privateKey) ||
    !['mailto:', 'https:'].includes(subjectUrl.protocol)
  ) {
    throw new Error('VAPID keys and subject are invalid.');
  }
  const vapid: Readonly<VapidEnvironment> = Object.freeze({ publicKey, privateKey, subject });
  return Object.freeze({ ...base, vapid });
};

export const parseRenewalJobEnvironment = (values: NodeJS.ProcessEnv = process.env) =>
  Object.freeze({
    ...common(values),
    yookassa: Object.freeze({
      shopId: required(values, 'YUKASSA_SHOP_ID'),
      secretKey: required(values, 'YUKASSA_SECRET_KEY'),
      requestTimeoutMs: integer(values, 'YUKASSA_REQUEST_TIMEOUT_MS', 10000, 1000, 30000),
    }),
  });

export const parseMediaCleanupJobEnvironment = (values: NodeJS.ProcessEnv = process.env) =>
  Object.freeze({ ...common(values), s3: s3(values) });

export const parseVideoVerificationJobEnvironment = (values: NodeJS.ProcessEnv = process.env) => {
  const base = parseMediaCleanupJobEnvironment(values);
  if (values.TRAINER_VIDEO_UPLOADS_ENABLED !== 'true')
    throw new Error('Verification job requires TRAINER_VIDEO_UPLOADS_ENABLED=true.');
  const ffprobePath = values.VIDEO_VERIFY_FFPROBE_PATH?.trim() || 'ffprobe';
  if (ffprobePath.length > 1024 || ffprobePath.includes('\0'))
    throw new Error('VIDEO_VERIFY_FFPROBE_PATH is invalid.');
  const encryption = values.VIDEO_S3_SERVER_SIDE_ENCRYPTION ?? 'AES256';
  const kmsKeyId = values.VIDEO_S3_KMS_KEY_ID?.trim() || null;
  if (
    !['AES256', 'aws:kms'].includes(encryption) ||
    (encryption === 'aws:kms') !== (kmsKeyId !== null)
  )
    throw new Error('VIDEO_S3 encryption configuration is invalid.');
  const videoUploads: Readonly<VideoVerificationEnvironment> = Object.freeze({
    ffprobePath,
    verifyLeaseSeconds: integer(values, 'VIDEO_VERIFY_LEASE_SECONDS', 300, 30, 1800),
    verifyDeadlineSeconds: integer(values, 'VIDEO_VERIFY_DEADLINE_SECONDS', 900, 30, 3600),
    verifyMaxAttempts: integer(values, 'VIDEO_VERIFY_MAX_ATTEMPTS', 8, 1, 100),
    deleteGraceSeconds: integer(values, 'VIDEO_MEDIA_DELETE_GRACE_SECONDS', 86400, 86400, 604800),
    serverSideEncryption: encryption as 'AES256' | 'aws:kms',
    kmsKeyId,
  });
  return Object.freeze({ ...base, videoUploads });
};
