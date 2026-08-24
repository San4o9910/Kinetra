import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCorsOrigins } from '../src/config/env.js';

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
