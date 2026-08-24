import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseChatPhotoUploadTimeouts, parseCorsOrigins } from '../src/config/env.js';

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
