import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

import {
  parseChatPhotoUploadTimeouts,
  parseCorsOrigins,
  parseS3Environment,
  parseVideoUploadsEnvironment,
  parseTokenDeliveryWebhook,
  parseShutdownEnvironment,
  parseDatabaseUrl,
  parseYooKassaEnvironment,
} from '../src/config/env.js';
import { parsePaymentsEnabled } from '../src/config/payments.js';

test('payments default on and accept only explicit boolean strings', () => {
  assert.equal(parsePaymentsEnabled(undefined), true);
  assert.equal(parsePaymentsEnabled('true'), true);
  assert.equal(parsePaymentsEnabled('false'), false);
  for (const value of ['', '0', '1', 'yes', 'FALSE', ' false ', 'true\n']) {
    assert.throws(() => parsePaymentsEnabled(value), /PAYMENTS_ENABLED/u);
    assert.throws(
      () => parseYooKassaEnvironment('production', { PAYMENTS_ENABLED: value }),
      /PAYMENTS_ENABLED/u,
    );
  }
});

test('deferred payments allow absent credentials and reject retained provider credentials', () => {
  assert.equal(parseYooKassaEnvironment('production', { PAYMENTS_ENABLED: 'false' }), null);
  assert.equal(
    parseYooKassaEnvironment('production', {
      PAYMENTS_ENABLED: 'false',
      YUKASSA_SHOP_ID: '',
      YUKASSA_SECRET_KEY: '',
      YUKASSA_RETURN_URL: '',
    }),
    null,
  );
  for (const credentials of [
    { YUKASSA_SHOP_ID: 'synthetic-shop' },
    { YUKASSA_SECRET_KEY: 'synthetic-secret' },
    { YUKASSA_SHOP_ID: 'synthetic-shop', YUKASSA_SECRET_KEY: 'synthetic-secret' },
  ]) {
    assert.throws(
      () => parseYooKassaEnvironment('production', { PAYMENTS_ENABLED: 'false', ...credentials }),
      /credentials must be empty/u,
    );
  }
});

test('enabled and default payment configuration preserve production requirements', () => {
  const credentials = {
    YUKASSA_SHOP_ID: 'synthetic-shop',
    YUKASSA_SECRET_KEY: 'synthetic-secret',
    YUKASSA_RETURN_URL: 'https://app.example.test/payment/success',
  };
  for (const values of [{}, { PAYMENTS_ENABLED: 'true' }]) {
    assert.throws(() => parseYooKassaEnvironment('production', values), /required in production/u);
    assert.throws(
      () =>
        parseYooKassaEnvironment('production', { ...values, YUKASSA_SHOP_ID: 'synthetic-shop' }),
      /configuration is incomplete/u,
    );
    assert.equal(
      parseYooKassaEnvironment('production', { ...values, ...credentials })?.requestTimeoutMs,
      10000,
    );
    for (const overrides of [
      { YUKASSA_RETURN_URL: 'http://app.example.test/payment/success' },
      { YUKASSA_RETURN_URL: '' },
      { YUKASSA_REQUEST_TIMEOUT_MS: '0' },
      { YUKASSA_REQUEST_TIMEOUT_MS: '30001' },
    ]) {
      assert.throws(
        () => parseYooKassaEnvironment('production', { ...values, ...credentials, ...overrides }),
        /YUKASSA_/u,
      );
    }
  }
});

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

test('production database refuses local defaults, ambiguous TLS and URL overrides', () => {
  const valid = 'postgresql://worker:secure%40password@db.example.test/kinetra?sslmode=verify-full';
  assert.equal(parseDatabaseUrl('production', valid), valid);
  assert.match(parseDatabaseUrl('test', undefined), /localhost/u);
  for (const invalid of [
    undefined,
    '',
    valid + ' ',
    valid.replace('worker:', '%20:'),
    'http://db.example.test/kinetra',
    valid.replace('secure%40password', 'kinetra_local_only'),
    valid.replace('worker:secure%40password', ':'),
    valid.replace('?sslmode=verify-full', ''),
    valid + '&sslmode=disable',
    valid + '&ssl=false',
    valid + '&options=-c%20statement_timeout%3D0',
  ]) {
    assert.throws(() => parseDatabaseUrl('production', invalid), /DATABASE_URL/u);
  }
  for (const local of [
    'localhost',
    'localhost.',
    'db.localhost.',
    '127.0.0.1',
    '127.1',
    '2130706433',
    '0x7f000001',
    '[::1]',
    '[::ffff:127.0.0.1]',
    '0.0.0.0',
  ]) {
    assert.throws(
      () => parseDatabaseUrl('production', valid.replace('db.example.test', local)),
      /DATABASE_URL/u,
    );
  }
});

test('delivery webhook rejects credentials, redirects via URL, weak secrets and unbounded timeout', () => {
  const valid = {
    AUTH_TOKEN_DELIVERY_WEBHOOK_URL: 'https://delivery.example.test/v1/tokens',
    AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET: 'synthetic-test-only-delivery-secret-32plus',
  };
  assert.equal(parseTokenDeliveryWebhook(valid).timeoutMs, 10000);
  for (const url of [
    'http://delivery.example.test',
    'https://user:secret@delivery.example.test',
    'https://delivery.example.test?a=1',
    'https://delivery.example.test/#secret',
  ]) {
    assert.throws(
      () => parseTokenDeliveryWebhook({ ...valid, AUTH_TOKEN_DELIVERY_WEBHOOK_URL: url }),
      /AUTH_TOKEN_DELIVERY_WEBHOOK_URL/u,
    );
  }
  for (const secret of [
    '',
    'short',
    'contains whitespace even when long enough',
    'a'.repeat(513),
    'a'.repeat(32) + '\n',
  ]) {
    assert.throws(
      () => parseTokenDeliveryWebhook({ ...valid, AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET: secret }),
      /SECRET/u,
    );
  }
  assert.throws(
    () => parseTokenDeliveryWebhook({ ...valid, AUTH_TOKEN_DELIVERY_TIMEOUT_MS: '0' }),
    /TIMEOUT/u,
  );
  assert.deepEqual(parseShutdownEnvironment({}), { drainMs: 5000, timeoutMs: 25000 });
  assert.throws(
    () => parseShutdownEnvironment({ SHUTDOWN_DRAIN_MS: '5000', SHUTDOWN_TIMEOUT_MS: '5000' }),
    /SHUTDOWN/u,
  );
});

test('actual production startup requires secure cookie and configured webhook without networking', () => {
  const values = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://api:synthetic-password@db.example.test/kinetra?sslmode=verify-full',
    CORS_ORIGIN: 'https://app.example.test',
    JWT_ACCESS_SECRET: 'synthetic-test-only-jwt-secret-32plus',
    AUTH_TOKEN_DELIVERY_MODE: 'webhook',
    AUTH_TOKEN_DELIVERY_WEBHOOK_URL: 'https://delivery.example.test/token',
    AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET: 'synthetic-test-only-delivery-secret-32plus',
    YUKASSA_SHOP_ID: 'synthetic-shop',
    YUKASSA_SECRET_KEY: 'synthetic-key',
    YUKASSA_RETURN_URL: 'https://app.example.test/payment/success',
    VAPID_PUBLIC_KEY: 'a'.repeat(87),
    VAPID_PRIVATE_KEY: 'a'.repeat(43),
    VAPID_SUBJECT: 'mailto:test@example.test',
  };
  const moduleUrl = new URL('../src/config/env.ts', import.meta.url).href;
  const run = (overrides: NodeJS.ProcessEnv) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `try { await import(${JSON.stringify(moduleUrl)}); process.stdout.write('STARTUP_VALID'); } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }`,
      ],
      { env: { ...values, ...overrides }, encoding: 'utf8' },
    );
  const valid = run({});
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, 'STARTUP_VALID');
  const insecure = run({ AUTH_REFRESH_COOKIE_SECURE: 'false' });
  assert.equal(insecure.status, 1);
  assert.match(insecure.stderr, /AUTH_REFRESH_COOKIE_SECURE/u);
  for (const mode of ['console', 'disabled']) {
    const invalid = run({ AUTH_TOKEN_DELIVERY_MODE: mode });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /AUTH_TOKEN_DELIVERY_MODE=webhook/u);
  }
  const deferred = {
    PAYMENTS_ENABLED: 'false',
    YUKASSA_SHOP_ID: '',
    YUKASSA_SECRET_KEY: '',
    YUKASSA_RETURN_URL: '',
  };
  const noPayments = run(deferred);
  assert.equal(noPayments.status, 0, noPayments.stderr);
  assert.equal(noPayments.stdout, 'STARTUP_VALID');
  for (const [overrides, expected] of [
    [{ AUTH_REFRESH_COOKIE_SECURE: 'false' }, /AUTH_REFRESH_COOKIE_SECURE/u],
    [{ AUTH_TOKEN_DELIVERY_MODE: 'disabled' }, /AUTH_TOKEN_DELIVERY_MODE=webhook/u],
    [{ AUTH_TOKEN_DELIVERY_WEBHOOK_URL: '' }, /AUTH_TOKEN_DELIVERY_WEBHOOK_URL/u],
    [{ AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET: '' }, /AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET/u],
    [{ DATABASE_URL: values.DATABASE_URL.replace('?sslmode=verify-full', '') }, /DATABASE_URL/u],
  ] as const) {
    const invalid = run({ ...deferred, ...overrides });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, expected);
  }
});
