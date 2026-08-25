import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseChatPhotoUploadTimeouts,
  parseCorsOrigins,
  parseS3Environment,
  parseVideoUploadsEnvironment,
} from '../src/config/env.js';

test('CORS allowlist normalizes and deduplicates exact HTTP(S) origins', () => {
  assert.deepEqual(
    parseCorsOrigins(
      ' HTTPS://Example.COM:443/ , http://localhost:5173 , https://example.com ',
      'test',
    ),
    ['https://example.com', 'http://localhost:5173'],
  );
});

test('CORS allowlist rejects wildcards, credentials and non-origin URL components', () => {
  for (const invalid of [
    '',
    '*',
    'ftp://example.com',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com?query=yes',
    'https://example.com#fragment',
    'https://example.com,',
    'https://example.com,,https://other.example',
  ]) {
    assert.throws(() => parseCorsOrigins(invalid, 'test'), /CORS_ORIGIN/u, invalid);
  }
});

test('production CORS allowlist requires HTTPS', () => {
  assert.throws(
    () => parseCorsOrigins('http://app.example.com', 'production'),
    /must use HTTPS in production/u,
  );
  assert.deepEqual(parseCorsOrigins('https://app.example.com/', 'production'), [
    'https://app.example.com',
  ]);
});

test('chat photo body deadlines have safe defaults and fail closed', () => {
  assert.deepEqual(parseChatPhotoUploadTimeouts(undefined, undefined), {
    idleTimeoutMs: 15_000,
    totalTimeoutMs: 120_000,
  });
  assert.deepEqual(parseChatPhotoUploadTimeouts('1', '10'), {
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 10_000,
  });
  assert.deepEqual(parseChatPhotoUploadTimeouts('30', '120'), {
    idleTimeoutMs: 30_000,
    totalTimeoutMs: 120_000,
  });

  for (const [idle, total] of [
    ['0', '120'],
    ['31', '120'],
    ['15', '9'],
    ['15', '121'],
    ['10', '10'],
    ['20', '19'],
    ['1.5', '120'],
  ] as const) {
    assert.throws(
      () => parseChatPhotoUploadTimeouts(idle, total),
      /CHAT_PHOTO_UPLOAD_(?:IDLE|TOTAL)_TIMEOUT_SECONDS/u,
    );
  }
});

test('video upload settings default off with bounded production-safe values', () => {
  assert.deepEqual(parseVideoUploadsEnvironment({}), {
    enabled: false,
    maxBytes: 2_147_483_648,
    partSizeBytes: 16_777_216,
    partUrlTtlSeconds: 900,
    sessionTtlSeconds: 21_600,
    maxActivePerTrainer: 3,
    ffprobePath: 'ffprobe',
    verifyLeaseSeconds: 300,
    verifyDeadlineSeconds: 900,
    verifyMaxAttempts: 8,
    workerMaxStaleSeconds: 300,
    deleteGraceSeconds: 86_400,
    serverSideEncryption: 'AES256',
    kmsKeyId: null,
  });
});

test('video upload settings reject invalid limits, booleans and KMS combinations', () => {
  for (const values of [
    { TRAINER_VIDEO_UPLOADS_ENABLED: 'yes' },
    { VIDEO_UPLOAD_MAX_BYTES: '0' },
    { VIDEO_UPLOAD_PART_SIZE_BYTES: '5242879' },
    { VIDEO_UPLOAD_PART_URL_TTL_SECONDS: '901' },
    { VIDEO_UPLOAD_SESSION_TTL_SECONDS: '899' },
    { VIDEO_UPLOAD_MAX_ACTIVE_PER_TRAINER: '11' },
    { VIDEO_WORKER_MAX_STALE_SECONDS: '29' },
    { VIDEO_MEDIA_DELETE_GRACE_SECONDS: '86399' },
    { VIDEO_S3_SERVER_SIDE_ENCRYPTION: 'aws:kms' },
    { VIDEO_S3_SERVER_SIDE_ENCRYPTION: 'AES256', VIDEO_S3_KMS_KEY_ID: 'alias/kinetra' },
    { VIDEO_VERIFY_FFPROBE_PATH: `ffprobe\0unsafe` },
  ] as const) {
    assert.throws(() => parseVideoUploadsEnvironment(values), /VIDEO_|TRAINER_VIDEO/u);
  }

  assert.deepEqual(
    parseVideoUploadsEnvironment({
      TRAINER_VIDEO_UPLOADS_ENABLED: 'true',
      VIDEO_S3_SERVER_SIDE_ENCRYPTION: 'aws:kms',
      VIDEO_S3_KMS_KEY_ID: 'alias/kinetra-video',
    }).kmsKeyId,
    'alias/kinetra-video',
  );
});

test('private S3 configuration is complete and HTTP is restricted to explicit loopback', () => {
  assert.equal(parseS3Environment('test', {}), null);
  assert.throws(
    () => parseS3Environment('test', { S3_REGION: 'us-east-1' }),
    /S3 configuration is incomplete/u,
  );
  const complete = {
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'kinetra-test',
    S3_ACCESS_KEY_ID: 'test-access',
    S3_SECRET_ACCESS_KEY: 'test-secret',
  };
  assert.throws(
    () => parseS3Environment('test', { ...complete, S3_ENDPOINT: 'http://s3.example.test' }),
    /must use HTTPS/u,
  );
  assert.equal(
    parseS3Environment('test', { ...complete, S3_ENDPOINT: 'http://127.0.0.1:9000' })
      ?.forcePathStyle,
    true,
  );
  assert.throws(
    () =>
      parseS3Environment('production', {
        ...complete,
        S3_ENDPOINT: 'http://127.0.0.1:9000',
      }),
    /must use HTTPS/u,
  );
});
