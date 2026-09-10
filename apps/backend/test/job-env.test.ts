import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  parseMediaCleanupJobEnvironment,
  parseNotificationJobEnvironment,
  parseRenewalJobEnvironment,
  parseVideoVerificationJobEnvironment,
} from '../src/config/job-env.js';

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://job:synthetic-password@db.example.test/kinetra?sslmode=verify-full',
};
const media = {
  ...base,
  S3_REGION: 'test-region',
  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY_ID: 'synthetic-access',
  S3_SECRET_ACCESS_KEY: 'synthetic-secret',
};

test('deferred renewal job refuses execution before reading database or provider configuration', () => {
  const values = {
    PAYMENTS_ENABLED: 'false',
    get DATABASE_URL(): string {
      throw new Error('database configuration must not be read');
    },
    get YUKASSA_SHOP_ID(): string {
      throw new Error('provider configuration must not be read');
    },
  };
  assert.throws(() => parseRenewalJobEnvironment(values), /Renewals are disabled/u);
  assert.throws(
    () =>
      parseRenewalJobEnvironment({
        ...base,
        PAYMENTS_ENABLED: 'false',
        YUKASSA_SHOP_ID: 'test-shop',
        YUKASSA_SECRET_KEY: 'synthetic-secret',
      }),
    /Renewals are disabled/u,
  );
  for (const value of ['', '0', 'yes', 'FALSE', ' false ']) {
    assert.throws(
      () => parseRenewalJobEnvironment({ ...base, PAYMENTS_ENABLED: value }),
      /PAYMENTS_ENABLED/u,
    );
  }
  assert.equal(
    parseRenewalJobEnvironment({
      ...base,
      PAYMENTS_ENABLED: 'true',
      YUKASSA_SHOP_ID: 'test-shop',
      YUKASSA_SECRET_KEY: 'synthetic-secret',
    }).yookassa.shopId,
    'test-shop',
  );
  assert.throws(
    () => parseRenewalJobEnvironment({ ...base, PAYMENTS_ENABLED: 'true' }),
    /YUKASSA/u,
  );
});

test('each job validates only its purpose credentials and refuses missing required ones', () => {
  const notification = parseNotificationJobEnvironment({
    ...base,
    VAPID_PUBLIC_KEY: 'a'.repeat(87),
    VAPID_PRIVATE_KEY: 'a'.repeat(43),
    VAPID_SUBJECT: 'mailto:test@example.test',
    YUKASSA_REQUEST_TIMEOUT_MS: 'invalid-irrelevant',
    AUTH_TOKEN_DELIVERY_MODE: 'invalid-irrelevant',
  });
  assert.equal(notification.vapid.subject, 'mailto:test@example.test');
  assert.equal(
    parseRenewalJobEnvironment({
      ...base,
      YUKASSA_SHOP_ID: 'test-shop',
      YUKASSA_SECRET_KEY: 'synthetic-secret',
      VAPID_PUBLIC_KEY: 'invalid-irrelevant',
      YUKASSA_RETURN_URL: 'invalid-irrelevant',
    }).yookassa.requestTimeoutMs,
    10000,
  );
  assert.equal(
    parseMediaCleanupJobEnvironment({
      ...media,
      JWT_ACCESS_SECRET: 'irrelevant',
      VIDEO_S3_SERVER_SIDE_ENCRYPTION: 'invalid-irrelevant',
      S3_PRESIGNED_URL_TTL_SECONDS: 'invalid-irrelevant',
    }).s3.bucket,
    'test-bucket',
  );
  assert.throws(() => parseNotificationJobEnvironment(base), /VAPID/u);
  assert.throws(() => parseRenewalJobEnvironment(base), /YUKASSA/u);
  assert.throws(() => parseMediaCleanupJobEnvironment(base), /S3/u);
  assert.throws(
    () => parseMediaCleanupJobEnvironment({ ...media, S3_ENDPOINT: 'http://127.0.0.1:9000' }),
    /S3_ENDPOINT/u,
  );
  assert.throws(
    () => parseVideoVerificationJobEnvironment(media),
    /TRAINER_VIDEO_UPLOADS_ENABLED/u,
  );
  const verifier = parseVideoVerificationJobEnvironment({
    ...media,
    TRAINER_VIDEO_UPLOADS_ENABLED: 'true',
  });
  assert.equal(verifier.videoUploads.verifyDeadlineSeconds, 900);
  assert.equal(verifier.videoUploads.serverSideEncryption, 'AES256');
  assert.throws(
    () =>
      parseVideoVerificationJobEnvironment({
        ...media,
        TRAINER_VIDEO_UPLOADS_ENABLED: 'true',
        VIDEO_S3_SERVER_SIDE_ENCRYPTION: 'aws:kms',
      }),
    /encryption/u,
  );
});

test('job entrypoints have no API runtime/global environment imports and always close their own pools', async () => {
  for (const name of [
    'push/run-notifications',
    'payments/run-renewals',
    'chat/run-media-cleanup',
    'video-admin/run-media-cleanup',
    'video-admin/run-upload-worker',
  ]) {
    const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"][^'"]*(?:runtime|config\/env|db\/pool)\.js['"]/u);
    assert.match(source, /createJobDatabasePool/u);
    assert.match(source, /finally\s*\{/u);
    assert.match(source, /databasePool\?\.end\(\)/u);
  }
  const parser = await readFile(new URL('../src/config/job-env.ts', import.meta.url), 'utf8');
  assert.match(parser, /import type \{[^}]+\} from '\.\/env\.js'/u);
});
