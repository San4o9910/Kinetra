import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readEnvironment,
  validateApi,
  validateJob,
  validateMain,
} from './validate-production-env.mjs';

const common = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://worker:test%40secret@db.kinetra.test/kinetra?sslmode=verify-full',
};
const s3 = {
  S3_ENDPOINT: 'https://s3.kinetra.test',
  S3_REGION: 'test-1',
  S3_BUCKET: 'kinetra-fixture',
  S3_ACCESS_KEY_ID: 'fixture-key',
  S3_SECRET_ACCESS_KEY: 'fixture-secret',
  S3_FORCE_PATH_STYLE: 'false',
};
const vapid = {
  VAPID_PUBLIC_KEY: 'A'.repeat(87),
  VAPID_PRIVATE_KEY: 'B'.repeat(43),
  VAPID_SUBJECT: 'mailto:ops@kinetra.test',
};
const renewals = {
  YUKASSA_SHOP_ID: '1234',
  YUKASSA_SECRET_KEY: 'fixture-secret',
  YUKASSA_REQUEST_TIMEOUT_MS: '10000',
};
const main = {
  NODE_IMAGE: `node:22-bookworm-slim@sha256:${'a'.repeat(64)}`,
  NGINX_IMAGE: `nginxinc/nginx-unprivileged:stable@sha256:${'b'.repeat(64)}`,
  BACKEND_IMAGE: `registry.kinetra.test/backend@sha256:${'c'.repeat(64)}`,
  FRONTEND_IMAGE: `registry.kinetra.test/frontend@sha256:${'d'.repeat(64)}`,
  VCS_REF: 'a'.repeat(40),
  VITE_API_URL: 'https://app.kinetra.test',
  VITE_PRIVATE_MEDIA_ORIGIN: '',
  KINETRA_API_ENV_FILE: '/approved/api.env',
  KINETRA_VIDEO_SCRATCH_DIR: '/approved/scratch',
};
const api = {
  ...common,
  ...vapid,
  ...renewals,
  HOST: '0.0.0.0',
  PORT: '3000',
  TRUST_PROXY_HOPS: '1',
  CORS_ORIGIN: 'https://app.kinetra.test',
  JWT_ACCESS_SECRET: 's'.repeat(64),
  AUTH_REFRESH_COOKIE_SECURE: 'true',
  AUTH_TOKEN_DELIVERY_MODE: 'webhook',
  AUTH_TOKEN_DELIVERY_WEBHOOK_URL: 'https://delivery.kinetra.test/tokens',
  AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET: 'w'.repeat(64),
  AUTH_TOKEN_DELIVERY_TIMEOUT_MS: '10000',
  YUKASSA_RETURN_URL: 'https://app.kinetra.test/payment/success',
  CHAT_ENABLED: 'false',
  CHAT_PHOTO_UPLOADS_ENABLED: 'false',
  TRAINER_VIDEO_UPLOADS_ENABLED: 'false',
  READINESS_TIMEOUT_MS: '2000',
  SHUTDOWN_DRAIN_MS: '5000',
  SHUTDOWN_TIMEOUT_MS: '25000',
};
const video = {
  ...common,
  ...s3,
  TRAINER_VIDEO_UPLOADS_ENABLED: 'true',
  VIDEO_VERIFY_FFPROBE_PATH: '/usr/bin/ffprobe',
  VIDEO_VERIFY_LEASE_SECONDS: '300',
  VIDEO_VERIFY_DEADLINE_SECONDS: '900',
  VIDEO_VERIFY_MAX_ATTEMPTS: '8',
  VIDEO_MEDIA_DELETE_GRACE_SECONDS: '86400',
  VIDEO_S3_SERVER_SIDE_ENCRYPTION: 'AES256',
  VIDEO_S3_KMS_KEY_ID: '',
};

test('minimal purpose environments pass and unrelated API credentials are rejected', () => {
  validateMain(main);
  validateApi(api, main);
  const profiles = {
    migrate: common,
    notifications: { ...common, ...vapid },
    renewals: { ...common, ...renewals },
    'chat-cleanup': { ...common, ...s3 },
    'video-cleanup': { ...common, ...s3 },
    'video-verify': video,
  };
  for (const [name, values] of Object.entries(profiles)) {
    validateJob(values, name);
    assert.throws(
      () => validateJob({ ...values, JWT_ACCESS_SECRET: 'unexpected-credential' }, name),
      /unexpected key/,
    );
    for (const beta of ['true', 'false']) {
      assert.throws(
        () => validateJob({ ...values, FREE_BETA_ENABLED: beta }, name),
        /unexpected key/,
      );
    }
  }
});
test('deferred payment API accepts no YooKassa credentials while keeping auth and TLS guards', () => {
  const deferred = {
    ...api,
    PAYMENTS_ENABLED: 'false',
    YUKASSA_SHOP_ID: '',
    YUKASSA_SECRET_KEY: '',
    YUKASSA_RETURN_URL: '',
  };
  validateApi(deferred, main);
  const absent = { ...deferred };
  delete absent.YUKASSA_SHOP_ID;
  delete absent.YUKASSA_SECRET_KEY;
  delete absent.YUKASSA_RETURN_URL;
  validateApi(absent, main);
  for (const credentials of [
    { YUKASSA_SHOP_ID: 'synthetic-shop' },
    { YUKASSA_SECRET_KEY: 'synthetic-secret' },
    { YUKASSA_SHOP_ID: 'synthetic-shop', YUKASSA_SECRET_KEY: 'synthetic-secret' },
  ]) {
    assert.throws(
      () => validateApi({ ...deferred, ...credentials }, main),
      /credentials must be empty/,
    );
  }
  for (const overrides of [
    { AUTH_TOKEN_DELIVERY_WEBHOOK_URL: '' },
    { AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET: '' },
    { AUTH_TOKEN_DELIVERY_MODE: 'disabled' },
    { AUTH_REFRESH_COOKIE_SECURE: 'false' },
    { CORS_ORIGIN: 'http://app.kinetra.test' },
    { DATABASE_URL: common.DATABASE_URL.replace('?sslmode=verify-full', '') },
  ]) {
    assert.throws(() => validateApi({ ...deferred, ...overrides }, main));
  }
});
test('payment validation retains enabled defaults and rejects invalid flag values', () => {
  validateApi({ ...api, PAYMENTS_ENABLED: 'true' }, main);
  validateJob({ ...common, ...renewals, PAYMENTS_ENABLED: 'true' }, 'renewals');
  for (const values of [{}, { PAYMENTS_ENABLED: 'true' }]) {
    assert.throws(
      () => validateApi({ ...api, ...values, YUKASSA_SECRET_KEY: '' }, main),
      /YUKASSA_SECRET_KEY/,
    );
    assert.throws(
      () => validateApi({ ...api, ...values, YUKASSA_RETURN_URL: 'http://app.kinetra.test' }, main),
      /YUKASSA_RETURN_URL/,
    );
  }
  for (const value of ['', '0', 'yes', 'FALSE', ' false ']) {
    assert.throws(() => validateApi({ ...api, PAYMENTS_ENABLED: value }, main), /PAYMENTS_ENABLED/);
    assert.throws(
      () => validateJob({ ...common, ...renewals, PAYMENTS_ENABLED: value }, 'renewals'),
      /PAYMENTS_ENABLED/,
    );
  }
  for (const credentials of [{}, renewals]) {
    assert.throws(
      () => validateJob({ ...common, ...credentials, PAYMENTS_ENABLED: 'false' }, 'renewals'),
      /renewals are disabled/,
    );
  }
});
test('free beta validates only with payments disabled and preserves production security', () => {
  const deferred = {
    ...api,
    PAYMENTS_ENABLED: 'false',
    YUKASSA_SHOP_ID: '',
    YUKASSA_SECRET_KEY: '',
    YUKASSA_RETURN_URL: '',
  };
  validateApi({ ...api, FREE_BETA_ENABLED: 'false' }, main);
  validateApi({ ...deferred, FREE_BETA_ENABLED: 'false' }, main);
  validateApi({ ...deferred, FREE_BETA_ENABLED: 'true' }, main);
  for (const paymentOverrides of [{}, { PAYMENTS_ENABLED: 'true' }]) {
    assert.throws(
      () => validateApi({ ...api, ...paymentOverrides, FREE_BETA_ENABLED: 'true' }, main),
      /FREE_BETA_ENABLED=true requires PAYMENTS_ENABLED=false/,
    );
  }
  for (const value of ['', '0', '1', 'yes', 'FALSE', ' false ', 'true\n']) {
    assert.throws(
      () => validateApi({ ...deferred, FREE_BETA_ENABLED: value }, main),
      /FREE_BETA_ENABLED/,
    );
  }
  for (const overrides of [
    { YUKASSA_SHOP_ID: 'synthetic-shop' },
    { YUKASSA_SECRET_KEY: 'synthetic-secret' },
    { AUTH_TOKEN_DELIVERY_WEBHOOK_URL: '' },
    { AUTH_TOKEN_DELIVERY_WEBHOOK_SECRET: '' },
    { AUTH_TOKEN_DELIVERY_MODE: 'disabled' },
    { AUTH_REFRESH_COOKIE_SECURE: 'false' },
    { CORS_ORIGIN: 'http://app.kinetra.test' },
    { DATABASE_URL: common.DATABASE_URL.replace('?sslmode=verify-full', '') },
  ]) {
    assert.throws(() =>
      validateApi({ ...deferred, FREE_BETA_ENABLED: 'true', ...overrides }, main),
    );
  }
});
test('local hosts, blank encoded credentials, TLS overrides and template values fail', () => {
  for (const host of [
    'localhost',
    'localhost.',
    'sub.localhost',
    '127.0.0.2',
    '127.1',
    '2130706433',
    '0x7f000001',
    '[::1]',
    '[::ffff:7f00:1]',
  ]) {
    assert.throws(() =>
      validateJob(
        { ...common, DATABASE_URL: `postgresql://user:pass@${host}/db?sslmode=verify-full` },
        'migrate',
      ),
    );
  }
  for (const url of [
    'postgresql://%20:pass@db.kinetra.test/db?sslmode=verify-full',
    'postgresql://user:%20@db.kinetra.test/db?sslmode=verify-full',
    `${common.DATABASE_URL}&sslmode=disable`,
    `${common.DATABASE_URL}&ssl=false`,
  ])
    assert.throws(() => validateJob({ ...common, DATABASE_URL: url }, 'migrate'));
  assert.throws(() =>
    validateJob(
      {
        ...common,
        DATABASE_URL:
          'postgresql://user:kinetra%5Flocal_only@db.kinetra.test/db?sslmode=verify-full',
      },
      'migrate',
    ),
  );
  assert.throws(() => validateApi({ ...api, NODE_OPTIONS: '--inspect' }, main), /unexpected key/);
  assert.throws(() => validateMain({ ...main, NODE_IMAGE: 'REPLACE_WITH_DIGEST' }));
  assert.throws(() => validateMain({ ...main, VITE_API_URL: 'http://app.kinetra.test' }));
  assert.throws(() => validateMain({ ...main, VITE_API_URL: 'https://app.kinetra.test/path' }));
});
test('private media CSP origin and compose timeout/encryption bounds are enforced', () => {
  assert.throws(() => validateApi({ ...api, ...s3 }, main));
  validateApi({ ...api, ...s3 }, { ...main, VITE_PRIVATE_MEDIA_ORIGIN: s3.S3_ENDPOINT });
  assert.throws(() => validateApi({ ...api, SHUTDOWN_TIMEOUT_MS: '40000' }, main));
  assert.throws(() => validateApi({ ...api, SHUTDOWN_DRAIN_MS: '25000' }, main));
  for (const values of [
    { VIDEO_VERIFY_LEASE_SECONDS: '1801' },
    { VIDEO_VERIFY_DEADLINE_SECONDS: '901' },
    { VIDEO_MEDIA_DELETE_GRACE_SECONDS: '86399' },
    { VIDEO_S3_KMS_KEY_ID: 'unexpected' },
    { VIDEO_S3_SERVER_SIDE_ENCRYPTION: 'aws:kms' },
  ])
    assert.throws(() => validateJob({ ...video, ...values }, 'video-verify'));
});
test('raw file loader rejects interpolation, duplicates, symlink-prone paths and loose secret permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinetra-env-fixture-'));
  const path = join(dir, 'job.env');
  try {
    writeFileSync(path, 'NODE_ENV=production\n', { mode: 0o600 });
    assert.equal(readEnvironment(path, true).NODE_ENV, 'production');
    const link = join(dir, 'linked.env');
    symlinkSync(path, link);
    assert.throws(() => readEnvironment(link, true));
    for (const text of ['A=$SECRET\n', 'A=one\nA=two\n', "A='quoted'\n", 'A=value \n']) {
      writeFileSync(path, text);
      assert.throws(() => readEnvironment(path, true));
    }
    writeFileSync(path, 'NODE_ENV=production\n');
    chmodSync(path, 0o644);
    assert.throws(() => readEnvironment(path, true), /mode 0600/);
    assert.throws(() => readEnvironment('relative.env', true));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
