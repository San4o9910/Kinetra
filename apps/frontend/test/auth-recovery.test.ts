import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AuthLinkGate } from '../src/features/auth/AuthLinkGate.js';
import { ForgotPasswordScreen } from '../src/features/auth/ForgotPasswordScreen.js';
import {
  consumeAuthLink,
  listenForAuthLinkNavigation,
  resetPasswordIssue,
  type AuthLink,
} from '../src/features/auth/authLinks.js';
import { ApiClient, ApiRequestError } from '../src/lib/api.js';

const token = 'a'.repeat(43);

const navigationHarness = () => {
  let location = new URL('https://app.example.test/auth/reset-password');
  const events = new EventTarget();
  const replacements: string[] = [];
  const frames: AuthLink[] = [];
  const browser = {
    get location() {
      return location;
    },
    history: {
      replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
        location = new URL(String(url), location);
        replacements.push(location.href);
      },
    },
    addEventListener: (type: 'hashchange' | 'popstate', listener: (event: Event) => void) =>
      events.addEventListener(type, listener),
    removeEventListener: (type: 'hashchange' | 'popstate', listener: (event: Event) => void) =>
      events.removeEventListener(type, listener),
  };
  const dispose = listenForAuthLinkNavigation(browser, (link) => {
    assert.equal(location.hash, '', 'URL must be clean before the new form is rendered');
    assert.equal(location.search, '');
    frames.push(link);
  });
  const dispatch = (type: 'hashchange' | 'popstate', newURL = location.href) => {
    const event = new Event(type);
    if (type === 'hashchange') Object.assign(event, { newURL });
    events.dispatchEvent(event);
  };
  return {
    browser,
    replacements,
    frames,
    dispose,
    dispatch,
    navigate: (relativeUrl: string, type: 'hashchange' | 'popstate' = 'hashchange') => {
      location = new URL(relativeUrl, location);
      const navigatedUrl = location.href;
      dispatch(type, navigatedUrl);
      return navigatedUrl;
    },
  };
};

test('same-document auth links clean invalid input then deliver each new form independently', () => {
  const harness = navigationHarness();
  harness.navigate(`/auth/reset-password#token=${token}&token=${token}`);
  harness.navigate(`/auth/reset-password#token=${token}`);
  harness.navigate(`/auth/reset-password#token=${'b'.repeat(43)}`);
  assert.deepEqual(harness.frames, [
    { kind: 'reset', token: null },
    { kind: 'reset', token },
    { kind: 'reset', token: 'b'.repeat(43) },
  ]);
  assert.equal(harness.replacements.length, 3);
  harness.dispose();
});

test('paired popstate and delayed hashchange cannot discard or replay a consumed auth token', () => {
  const harness = navigationHarness();
  const earlierUrl = harness.navigate(`/auth/reset-password#token=${token}`, 'popstate');
  harness.dispatch('hashchange', earlierUrl);
  assert.deepEqual(harness.frames, [{ kind: 'reset', token }]);
  harness.navigate(`/auth/verify-email#token=${'v'.repeat(43)}`, 'popstate');
  harness.dispatch('hashchange', earlierUrl);
  assert.deepEqual(harness.frames, [
    { kind: 'reset', token },
    { kind: 'verify', token: 'v'.repeat(43) },
  ]);
  harness.dispose();
});

test('ordinary app history never replaces a form or resets the mounted application', () => {
  const harness = navigationHarness();
  harness.navigate(`/auth/reset-password#token=${token}`);
  const frameCount = harness.frames.length;
  const replacementCount = harness.replacements.length;
  for (const route of ['/login', '/', '/schedule', '/progress', '/settings', '/?day=1#workout']) {
    harness.navigate(route, 'popstate');
  }
  assert.equal(harness.frames.length, frameCount);
  assert.equal(harness.replacements.length, replacementCount);
  harness.dispose();
  harness.navigate(`/auth/reset-password#token=${token}`);
  assert.equal(
    harness.frames.length,
    frameCount,
    'disposed listeners must not render another form',
  );
});
const authSession = (accessToken: string, id = 'verified-user') => ({
  user: {
    id,
    email: 'owner@example.test',
    phone: null,
    emailVerified: true,
    createdAt: '2026-09-10T00:00:00.000Z',
  },
  accessToken,
  tokenType: 'Bearer',
  expiresIn: 900,
});

test('auth links accept only one fragment token and remove it from history before use', () => {
  for (const [pathname, kind] of [
    ['/auth/reset-password', 'reset'],
    ['/auth/verify-email', 'verify'],
  ] as const) {
    const writes: unknown[][] = [];
    const link = consumeAuthLink(
      { pathname, search: '', hash: `#token=${token}` },
      {
        replaceState: (...arguments_) => {
          writes.push(arguments_);
        },
      },
    );
    assert.deepEqual(writes, [[null, '', pathname]]);
    assert.deepEqual(link, { kind, token });
    assert.equal(JSON.stringify(writes).includes(token), false);
  }
});

test('malformed or query auth tokens fail closed and still clean the URL', () => {
  for (const [search, hash] of [
    ['', ''],
    ['', '#token=short'],
    ['', `#token=${token}&token=${token}`],
    [`?token=${token}`, ''],
    [`?token=${token}`, `#token=${token}`],
    ['', `#token=${token}&next=https://example.test`],
    ['', '#token=%3Cscript%3E'],
  ]) {
    let cleaned = false;
    assert.deepEqual(
      consumeAuthLink(
        { pathname: '/auth/reset-password', search: search!, hash: hash! },
        {
          replaceState: (_state, _title, url) => {
            cleaned = url === '/auth/reset-password';
          },
        },
      ),
      { kind: 'reset', token: null },
    );
    assert.equal(cleaned, true);
  }
  assert.deepEqual(
    consumeAuthLink(
      { pathname: '/auth/reset-password', search: '', hash: `#token=${token}` },
      {
        replaceState: () => {
          throw new Error('history unavailable');
        },
      },
    ),
    { kind: 'reset', token: null },
  );
});

test('ordinary navigation is untouched by the auth link reader', () => {
  assert.equal(
    consumeAuthLink(
      { pathname: '/payment/success', search: '?payment=public-reference', hash: '#section' },
      {
        replaceState: () => {
          assert.fail('ordinary history must not change');
        },
      },
    ),
    null,
  );
});

test('new passwords respect matching, minimum length and the bcrypt byte boundary', () => {
  assert.equal(resetPasswordIssue('long-enough-password', 'long-enough-password'), null);
  assert.match(resetPasswordIssue('short', 'short')!, /10/u);
  assert.match(resetPasswordIssue('long-enough-password', 'different-password')!, /не совпадают/u);
  assert.equal(resetPasswordIssue('я'.repeat(36), 'я'.repeat(36)), null);
  assert.match(resetPasswordIssue('я'.repeat(37), 'я'.repeat(37))!, /слишком длинный/u);
});

test('password request is unauthenticated and neutral for known and unknown email', async () => {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json(
        { message: 'If the account exists, reset instructions will be sent.' },
        { status: 202 },
      );
    },
  });
  assert.equal(await client.requestPasswordReset(' known@example.test '), undefined);
  assert.equal(await client.requestPasswordReset('unknown@example.test'), undefined);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.url, 'https://api.example.test/api/v1/auth/password-reset/request');
    assert.equal(request.init?.method, 'POST');
    assert.equal(request.init?.credentials, 'omit');
    assert.equal(new Headers(request.init?.headers).has('Authorization'), false);
    assert.deepEqual(JSON.parse(String(request.init?.body)), {
      identifier: index === 0 ? 'known@example.test' : 'unknown@example.test',
    });
  }
  assert.equal(client.hasAccessToken(), false);
});

test('reset confirmation sends the token only in the body and clears in-memory authentication', async () => {
  const calls: string[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith('/login')) return Response.json(authSession('old-session'));
      assert.equal(String(url).endsWith('/password-reset/confirm'), true);
      assert.equal(String(url).includes(token), false);
      assert.equal(init?.credentials, 'include');
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        token,
        newPassword: 'new-correct-password',
      });
      return Response.json({ message: 'Password has been reset.' });
    },
  });
  await client.login('owner@example.test', 'old-correct-password');
  const confirmation = client.confirmPasswordReset(token, 'new-correct-password');
  assert.equal(client.getInMemoryAccessToken(), null);
  await confirmation;
  assert.equal(client.getInMemoryAuthSubjectId(), null);
  assert.equal(calls.length, 2);
});

test('verification installs only the verified session and never leaks token into URL or headers', async () => {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'https://api.example.test/api/v1/auth/verify-email');
      assert.equal(init?.credentials, 'include');
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      assert.deepEqual(JSON.parse(String(init?.body)), { token });
      return Response.json(authSession('new-verified-session'));
    },
  });
  await client.verifyEmail(token);
  assert.equal(client.getInMemoryAccessToken(), 'new-verified-session');
  assert.equal(client.getInMemoryAuthSubjectId(), 'verified-user');
});

test('failed verification cannot retain a previous account token', async () => {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/login')) return Response.json(authSession('old-session'));
      return Response.json(
        { error: { code: 'INVALID_OR_EXPIRED_VERIFICATION_TOKEN', message: 'Invalid token.' } },
        { status: 400 },
      );
    },
  });
  await client.login('owner@example.test', 'correct-password');
  await assert.rejects(
    client.verifyEmail(token),
    (error: unknown) =>
      error instanceof ApiRequestError && error.code === 'INVALID_OR_EXPIRED_VERIFICATION_TOKEN',
  );
  assert.equal(client.getInMemoryAccessToken(), null);
  assert.equal(client.getInMemoryAuthSubjectId(), null);
});

test('a queued reset superseded by a new login cannot send a stale cookie-clearing request', async () => {
  const calls: string[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return Response.json(authSession('latest-session', 'latest-user'));
    },
  });
  const staleReset = client.confirmPasswordReset(token, 'new-password');
  const newestLogin = client.login('latest@example.test', 'correct-password');
  await assert.rejects(
    staleReset,
    (error: unknown) => error instanceof ApiRequestError && error.code === 'AUTH_SESSION_CHANGED',
  );
  await newestLogin;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.endsWith('/login'), true);
  assert.equal(client.getInMemoryAuthSubjectId(), 'latest-user');
});

test('recovery forms expose accessible names, native controls and linked instructions without rendering token', () => {
  const request = renderToStaticMarkup(
    createElement(ForgotPasswordScreen, { onBack: () => undefined }),
  );
  assert.match(request, /aria-labelledby="reset-request-title"/u);
  assert.match(request, /<label for="reset-email">/u);
  assert.match(request, /id="reset-email"[^>]*type="email"/u);
  const reset = renderToStaticMarkup(
    createElement(AuthLinkGate, {
      link: { kind: 'reset', token },
      children: createElement('div', { 'data-testid': 'private-app' }),
    }),
  );
  assert.match(reset, /<label for="reset-new-password">/u);
  assert.match(reset, /<label for="reset-confirm-password">/u);
  assert.match(reset, /aria-describedby="reset-password-hint reset-password-issue"/u);
  assert.match(reset, /id="reset-password-issue"[^>]*aria-live="polite"/u);
  assert.doesNotMatch(reset, /private-app/u);
  assert.equal(reset.includes(token), false);
  const verify = renderToStaticMarkup(
    createElement(AuthLinkGate, { link: { kind: 'verify', token }, children: null }),
  );
  assert.match(verify, /data-testid="email-verification-submit"[^>]*type="button"/u);
  assert.equal(verify.includes(token), false);
});
