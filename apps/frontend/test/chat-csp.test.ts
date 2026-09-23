import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertBuildApiOrigin,
  buildImageContentSecurityPolicy,
  buildNormalizedFrontendEnv,
  normalizeApiOrigin,
  normalizePrivateMediaOrigin,
} from '../vite.config.js';

test('T12 image CSP allows only the app, blob previews and one exact private media origin', () => {
  assert.equal(normalizePrivateMediaOrigin(undefined), null);
  assert.equal(normalizePrivateMediaOrigin('  '), null);
  assert.equal(
    normalizePrivateMediaOrigin('https://media.kinetra.test:8443'),
    'https://media.kinetra.test:8443',
  );
  assert.equal(normalizePrivateMediaOrigin('http://127.0.0.1:3000', true), 'http://127.0.0.1:3000');
  assert.equal(
    buildImageContentSecurityPolicy('https://media.kinetra.test'),
    "img-src 'self' blob: https://media.kinetra.test; media-src 'self' blob: https://media.kinetra.test;",
  );
  assert.equal(
    buildImageContentSecurityPolicy(null),
    "img-src 'self' blob:; media-src 'self' blob:;",
  );

  for (const unsafeValue of [
    'https://media.kinetra.test/private',
    'https://media.kinetra.test?scope=chat',
    'https://user:secret@media.kinetra.test',
    'data:image/webp;base64,AAAA',
    '*.kinetra.test',
    'http://media.kinetra.test',
  ]) {
    assert.throws(() => normalizePrivateMediaOrigin(unsafeValue));
  }

  assert.throws(() => normalizePrivateMediaOrigin('http://127.0.0.1:3000'));
  assert.throws(() => normalizePrivateMediaOrigin('http://media.kinetra.test', true));
});

test('builds require an explicit API origin while local development can start unconfigured', () => {
  assert.throws(() => assertBuildApiOrigin('build', null), /VITE_API_URL is required/);
  assert.doesNotThrow(() => assertBuildApiOrigin('serve', null));
  assert.doesNotThrow(() => assertBuildApiOrigin('build', 'https://api.kinetra.test'));
});

test('frontend API and private media config share an exact secure origin policy', () => {
  for (const normalizeOrigin of [normalizeApiOrigin, normalizePrivateMediaOrigin]) {
    assert.equal(normalizeOrigin(undefined), null);
    assert.equal(normalizeOrigin('  '), null);
    assert.equal(normalizeOrigin(' HTTPS://API.KINETRA.TEST:443 '), 'https://api.kinetra.test');
    assert.equal(normalizeOrigin('http://localhost:3000', true), 'http://localhost:3000');
    assert.equal(normalizeOrigin('http://127.0.0.1:3000', true), 'http://127.0.0.1:3000');
    assert.equal(normalizeOrigin('http://[::1]:3000', true), 'http://[::1]:3000');

    for (const unsafeValue of [
      'http://api.kinetra.test',
      'http://localhost:3000',
      'http://api.kinetra.test:3000',
      'https://user:secret@api.kinetra.test',
      'https://api.kinetra.test/v1',
      'https://api.kinetra.test?tenant=one',
      'https://api.kinetra.test#fragment',
      'ws://api.kinetra.test',
      '//api.kinetra.test',
    ]) {
      assert.throws(() => normalizeOrigin(unsafeValue));
    }

    assert.throws(() => normalizeOrigin('http://api.kinetra.test', true));
  }

  assert.deepEqual(
    buildNormalizedFrontendEnv(
      normalizeApiOrigin('https://api.kinetra.test/'),
      normalizePrivateMediaOrigin('https://media.kinetra.test/'),
    ),
    {
      'import.meta.env.VITE_API_URL': '"https://api.kinetra.test"',
      'import.meta.env.VITE_PRIVATE_MEDIA_ORIGIN': '"https://media.kinetra.test"',
    },
  );
});
