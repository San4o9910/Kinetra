import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiClient, ApiRequestError, resolveApiBaseUrl } from '../src/lib/api.js';

const defaultSubjectId = '00000000-0000-4000-8000-000000000001';

const session = (token: string, subjectId = defaultSubjectId) => ({
  user: {
    id: subjectId,
    email: 'test@example.com',
    phone: null,
    emailVerified: true,
    createdAt: '2026-08-20T00:00:00.000Z',
  },
  accessToken: token,
  tokenType: 'Bearer' as const,
  expiresIn: 900,
});

const profile = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'test@example.com',
    phone: null,
    emailVerified: true,
    avatarUrl: null,
    username: null,
    firstName: null,
    onboardingStatus: 'survey_pending' as const,
    notificationEnabled: true,
    level: 'beginner' as const,
    timezone: 'Europe/Moscow',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
  survey: null,
  subscription: {
    provider: null,
    status: 'none' as const,
    isActive: false,
    startsAt: null,
    expiresAt: null,
    amountMinor: null,
    currency: null,
  },
};

const createDeterministicExclusiveLockManager = (): LockManager => {
  let tail: Promise<void> = Promise.resolve();

  const request = async <T>(
    _name: string,
    _options: LockOptions,
    callback: () => T | PromiseLike<T>,
  ): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  };

  return { request } as unknown as LockManager;
};

test('an empty normalized Vite API origin keeps the runtime fallback', () => {
  assert.equal(
    resolveApiBaseUrl(undefined, 'https://app.kinetra.test:3000'),
    'https://app.kinetra.test:3000',
  );
  assert.equal(
    resolveApiBaseUrl('', 'https://app.kinetra.test:3000'),
    'https://app.kinetra.test:3000',
  );
  assert.equal(
    resolveApiBaseUrl('   ', 'https://app.kinetra.test:3000'),
    'https://app.kinetra.test:3000',
  );
  assert.equal(
    resolveApiBaseUrl(' https://api.kinetra.test/ ', 'unused'),
    'https://api.kinetra.test',
  );
});

test('a truncated successful JSON body maps to a localized network error', async () => {
  const truncatedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"status":"ok"'));
      controller.error(new TypeError('secret browser transport detail'));
    },
  });
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async () =>
      new Response(truncatedBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });

  await assert.rejects(
    client.fetchHealth(new AbortController().signal),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.status === 0 &&
      error.code === 'NETWORK_ERROR' &&
      error.kind === 'network' &&
      error.message ===
        'Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз.' &&
      !error.message.includes('secret'),
  );
});

test('malformed successful JSON maps to a localized server response error', async () => {
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async () =>
      new Response('{not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });

  await assert.rejects(
    client.fetchHealth(new AbortController().signal),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.status === 200 &&
      error.code === 'INVALID_RESPONSE' &&
      error.kind === 'server' &&
      error.message === 'Сервер вернул некорректный ответ. Попробуйте ещё раз.',
  );
});

test('protected request refreshes once after a 401 and retries with the new access token', async () => {
  const calls: Array<{ readonly path: string; readonly authorization: string | null }> = [];
  let refreshCount = 0;
  let meCount = 0;

  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({ path: url.pathname, authorization: headers.get('authorization') });

      if (url.pathname === '/api/v1/auth/refresh') {
        refreshCount += 1;
        return Response.json(session(`fresh-${refreshCount}`));
      }

      if (url.pathname === '/api/v1/me') {
        meCount += 1;
        if (meCount === 1) {
          return Response.json(
            { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Expired.' } },
            { status: 401 },
          );
        }
        return Response.json(profile);
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  assert.equal(await client.bootstrapSession(), true);
  const result = await client.fetchMe();
  assert.equal(result.user.onboardingStatus, 'survey_pending');
  assert.equal(refreshCount, 2);
  assert.equal(calls.at(-1)?.authorization, 'Bearer fresh-2');
});

test('concurrent bootstrap calls share one refresh rotation', async () => {
  let refreshCount = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async () => {
      refreshCount += 1;
      await gate;
      return Response.json(session('shared-token'));
    },
  });

  const first = client.bootstrapSession();
  const second = client.bootstrapSession();
  release?.();

  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(refreshCount, 1);
});

test('T12 browser auth mutations fail closed when Web Locks are unavailable', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let fetchCalls = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });

  try {
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetchImpl: async () => {
        fetchCalls += 1;
        return Response.json(session('unsafe-token'));
      },
    });

    await assert.rejects(
      client.login('account-a@example.test', 'password-a'),
      (error: unknown) =>
        error instanceof ApiRequestError &&
        error.code === 'AUTH_COORDINATION_UNAVAILABLE' &&
        error.kind === 'auth',
    );
    assert.equal(fetchCalls, 0, 'an unsupported browser must not mutate the shared auth cookie');
  } finally {
    if (windowDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    }
    if (navigatorDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'navigator');
    } else {
      Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    }
  }
});

test('T12 origin-wide Web Lock serializes two clients before a competing login', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let cookieSubjectId = 'none';
  const operations: string[] = [];
  let releaseRefresh!: () => void;
  let signalRefreshStarted!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refreshStarted = new Promise<void>((resolve) => {
    signalRefreshStarted = resolve;
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: createDeterministicExclusiveLockManager() },
  });

  try {
    const sharedFetch: typeof fetch = async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/api/v1/auth/login') {
        const body = JSON.parse(String(init?.body)) as { readonly identifier: string };
        const accountB = body.identifier.startsWith('account-b');
        operations.push(accountB ? 'login:B' : 'login:A');
        cookieSubjectId = accountB ? 'B' : 'A';
        return Response.json(
          session(
            accountB ? 'account-b-token' : 'account-a-token',
            accountB
              ? '00000000-0000-4000-8000-00000000000b'
              : '00000000-0000-4000-8000-00000000000a',
          ),
        );
      }
      if (pathname === '/api/v1/auth/refresh') {
        operations.push('refresh:A');
        signalRefreshStarted();
        await refreshGate;
        cookieSubjectId = 'A';
        return Response.json(
          session('rotated-account-a-token', '00000000-0000-4000-8000-00000000000a'),
        );
      }
      throw new Error(`Unexpected request ${pathname}`);
    };
    const accountATab = new ApiClient({ baseUrl: 'http://api.test', fetchImpl: sharedFetch });
    const accountBTab = new ApiClient({ baseUrl: 'http://api.test', fetchImpl: sharedFetch });
    await accountATab.login('account-a@example.test', 'password-a');

    const staleRefresh = accountATab.refreshInMemoryAccessToken();
    await refreshStarted;
    const accountBLogin = accountBTab.login('account-b@example.test', 'password-b');
    await Promise.resolve();
    assert.deepEqual(operations, ['login:A', 'refresh:A']);

    releaseRefresh();
    await Promise.all([staleRefresh, accountBLogin]);
    assert.deepEqual(operations, ['login:A', 'refresh:A', 'login:B']);
    assert.equal(cookieSubjectId, 'B', 'the later account-B login must own the final cookie');
  } finally {
    if (windowDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    }
    if (navigatorDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'navigator');
    } else {
      Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    }
  }
});

test('T12 stale account-A refresh cannot overtake logout and account-B login', async () => {
  const operations: string[] = [];
  const protectedAuthorizations: string[] = [];
  const logoutAuthorizations: string[] = [];
  let releaseRefresh: (() => void) | null = null;
  let announceRefreshStarted: (() => void) | null = null;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refreshStarted = new Promise<void>((resolve) => {
    announceRefreshStarted = resolve;
  });

  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/v1/auth/login') {
        const body = JSON.parse(String(init?.body)) as { readonly identifier: string };
        operations.push(`login:${body.identifier}`);
        return Response.json(
          session(body.identifier.startsWith('account-b') ? 'account-b-token' : 'account-a-token'),
        );
      }

      if (url.pathname === '/api/v1/auth/refresh') {
        operations.push('refresh:account-a');
        announceRefreshStarted?.();
        await refreshGate;
        return Response.json(session('late-account-a-token'));
      }

      if (url.pathname === '/api/v1/auth/logout') {
        operations.push('logout:account-a');
        logoutAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(null, { status: 204 });
      }

      if (url.pathname === '/api/v1/me') {
        protectedAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
        return Response.json(profile);
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  await client.login('account-a@example.test', 'password-a');
  const staleRefreshResult = client.refreshInMemoryAccessToken().then(
    () => 'resolved' as const,
    (error: unknown) => error,
  );
  await refreshStarted;

  const logoutAccountA = client.logout();
  const loginAccountB = client.login('account-b@example.test', 'password-b');
  await Promise.resolve();
  assert.deepEqual(operations, ['login:account-a@example.test', 'refresh:account-a']);

  releaseRefresh?.();
  const staleRefreshError = await staleRefreshResult;
  assert.ok(staleRefreshError instanceof ApiRequestError);
  assert.equal(staleRefreshError.code, 'NO_SESSION');
  await logoutAccountA;
  await loginAccountB;

  assert.equal(client.getInMemoryAccessToken(), 'account-b-token');
  await client.fetchMe();
  assert.deepEqual(protectedAuthorizations, ['Bearer account-b-token']);
  assert.deepEqual(logoutAuthorizations, ['Bearer account-a-token']);
  assert.deepEqual(operations, [
    'login:account-a@example.test',
    'refresh:account-a',
    'logout:account-a',
    'login:account-b@example.test',
  ]);
});

test('T12 account-A logout cannot revoke an externally switched account-B cookie', async () => {
  const accountAId = '00000000-0000-4000-8000-00000000000a';
  const accountBId = '00000000-0000-4000-8000-00000000000b';
  let cookieSubjectId = accountAId;
  let logoutCalls = 0;
  let refreshCalls = 0;
  const logoutAuthorizations: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));

    if (url.pathname === '/api/v1/auth/login') {
      cookieSubjectId = accountAId;
      return Response.json(session('account-a-token', accountAId));
    }

    if (url.pathname === '/api/v1/auth/refresh') {
      refreshCalls += 1;
      return Response.json(session(`refreshed-${refreshCalls}`, cookieSubjectId));
    }

    if (url.pathname === '/api/v1/auth/logout') {
      logoutCalls += 1;
      logoutAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
      // Model the server's atomic subject mismatch: cookie B is not revoked and
      // a bearer-bound response never emits a cookie-clearing Set-Cookie header.
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected request ${url.pathname}`);
  };
  const accountATab = new ApiClient({ baseUrl: 'http://api.test', fetchImpl });

  await accountATab.login('account-a@example.test', 'password-a');
  cookieSubjectId = accountBId;
  await accountATab.logout();

  assert.equal(accountATab.getInMemoryAccessToken(), null);
  assert.equal(accountATab.getInMemoryAuthSubjectId(), null);
  assert.equal(logoutCalls, 1);
  assert.deepEqual(logoutAuthorizations, ['Bearer account-a-token']);
  assert.equal(refreshCalls, 0, 'logout must never rotate the shared refresh cookie');

  const accountBTab = new ApiClient({ baseUrl: 'http://api.test', fetchImpl });
  assert.equal(await accountBTab.bootstrapSession(), true);
  assert.equal(accountBTab.getInMemoryAuthSubjectId(), accountBId);
  assert.equal(accountBTab.getInMemoryAccessToken(), 'refreshed-1');
  assert.equal(logoutCalls, 1);
});

test('T12 terminal invalidation rejects a delayed account-A response before account-B login', async () => {
  const protectedAuthorizations: string[] = [];
  let releaseAccountAResponse: (() => void) | null = null;
  let announceAccountARequest: (() => void) | null = null;
  const accountAResponseGate = new Promise<void>((resolve) => {
    releaseAccountAResponse = resolve;
  });
  const accountARequestStarted = new Promise<void>((resolve) => {
    announceAccountARequest = resolve;
  });

  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/v1/auth/login') {
        const body = JSON.parse(String(init?.body)) as { readonly identifier: string };
        return Response.json(
          session(body.identifier.startsWith('account-b') ? 'account-b-token' : 'account-a-token'),
        );
      }

      if (url.pathname === '/api/v1/me/survey') {
        protectedAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
        announceAccountARequest?.();
        const delayedBody = JSON.stringify({
          ...profile,
          user: { ...profile.user, onboardingStatus: 'onboarding_pending' },
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              void accountAResponseGate.then(() => {
                controller.enqueue(new TextEncoder().encode(delayedBody));
                controller.close();
              });
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.pathname === '/api/v1/me') {
        protectedAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
        return Response.json(profile);
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  await client.login('account-a@example.test', 'password-a');
  const delayedAccountASave = client.saveSurvey({
    goal: 'weight_loss',
    level: 'beginner',
    location: 'home',
    equipment: ['none'],
    limitations: ['none'],
  });
  await accountARequestStarted;

  client.clearSession();
  assert.equal(client.getInMemoryAccessToken(), null);
  releaseAccountAResponse?.();
  await assert.rejects(
    delayedAccountASave,
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.code === 'AUTH_SESSION_CHANGED' &&
      error.kind === 'request',
  );
  assert.equal(client.getInMemoryAccessToken(), null);

  await client.login('account-b@example.test', 'password-b');
  assert.equal(client.getInMemoryAccessToken(), 'account-b-token');
  await client.fetchMe();
  assert.deepEqual(protectedAuthorizations, ['Bearer account-a-token', 'Bearer account-b-token']);
});

test('T12 cross-tab refresh subject mismatch is terminal and cannot authorize account B', async () => {
  const accountAId = '00000000-0000-4000-8000-00000000000a';
  const accountBId = '00000000-0000-4000-8000-00000000000b';
  const protectedAuthorizations: string[] = [];
  let refreshCalls = 0;
  let chatCalls = 0;

  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/v1/auth/login') {
        const body = JSON.parse(String(init?.body)) as { readonly identifier: string };
        return body.identifier.startsWith('account-b')
          ? Response.json(session('account-b-token', accountBId))
          : Response.json(session('account-a-token', accountAId));
      }

      if (url.pathname === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        return Response.json(session('external-account-b-token', accountBId));
      }

      if (url.pathname === '/api/v1/me') {
        const authorization = new Headers(init?.headers).get('authorization') ?? '';
        protectedAuthorizations.push(authorization);
        return Response.json({
          ...profile,
          user: {
            ...profile.user,
            id: authorization.includes('account-b') ? accountBId : accountAId,
          },
        });
      }

      if (url.pathname === '/api/v1/chat/session') {
        chatCalls += 1;
        return Response.json({
          role: 'client',
          enabled: true,
          photo_uploads_enabled: false,
          available: true,
          conversation: null,
        });
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  await client.login('account-a@example.test', 'password-a');
  assert.equal(client.getInMemoryAuthSubjectId(), accountAId);
  assert.equal((await client.fetchMe()).user.id, accountAId);

  let terminalSessionPath = false;
  await assert.rejects(client.refreshInMemoryAccessToken(), (error: unknown) => {
    terminalSessionPath =
      error instanceof ApiRequestError &&
      error.code === 'AUTH_SESSION_CHANGED' &&
      error.kind === 'auth';
    return terminalSessionPath;
  });
  assert.equal(terminalSessionPath, true, 'App auth-error handling must take the logout path');
  assert.equal(client.getInMemoryAccessToken(), null);
  assert.equal(client.getInMemoryAuthSubjectId(), null);

  await assert.rejects(
    client.fetchMe(),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.code === 'AUTH_SESSION_CHANGED' &&
      error.kind === 'auth',
  );
  await assert.rejects(
    client.getChatSession(),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.code === 'AUTH_SESSION_CHANGED' &&
      error.kind === 'auth',
  );
  assert.equal(refreshCalls, 1);
  assert.equal(chatCalls, 0);
  assert.deepEqual(protectedAuthorizations, ['Bearer account-a-token']);

  await client.login('account-b@example.test', 'password-b');
  assert.equal(client.getInMemoryAuthSubjectId(), accountBId);
  assert.equal((await client.fetchMe()).user.id, accountBId);
  assert.deepEqual(protectedAuthorizations, ['Bearer account-a-token', 'Bearer account-b-token']);
});

test('T12 JSON 401 subject mismatch never retries the protected request as account B', async () => {
  const accountAId = '00000000-0000-4000-8000-00000000000a';
  const accountBId = '00000000-0000-4000-8000-00000000000b';
  const authorizations: string[] = [];
  let refreshCalls = 0;
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/auth/login') {
        return Response.json(session('account-a-token', accountAId));
      }
      if (url.pathname === '/api/v1/me') {
        authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
        return Response.json(
          { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Expired.' } },
          { status: 401 },
        );
      }
      if (url.pathname === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        return Response.json(session('account-b-token', accountBId));
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  await client.login('account-a@example.test', 'password-a');
  await assert.rejects(
    client.fetchMe(),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.code === 'AUTH_SESSION_CHANGED' &&
      error.kind === 'auth',
  );
  assert.deepEqual(authorizations, ['Bearer account-a-token']);
  assert.equal(refreshCalls, 1);
  assert.equal(client.getInMemoryAccessToken(), null);
});

test('T12 void 401 subject mismatch never retries the mutation as account B', async () => {
  const accountAId = '00000000-0000-4000-8000-00000000000a';
  const accountBId = '00000000-0000-4000-8000-00000000000b';
  const authorizations: string[] = [];
  let refreshCalls = 0;
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/auth/login') {
        return Response.json(session('account-a-token', accountAId));
      }
      if (url.pathname === '/api/v1/settings/notifications') {
        authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
        return Response.json(
          { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Expired.' } },
          { status: 401 },
        );
      }
      if (url.pathname === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        return Response.json(session('account-b-token', accountBId));
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  await client.login('account-a@example.test', 'password-a');
  await assert.rejects(
    client.updateNotifications({
      workout_reminders: true,
      reminder_time: '09:00',
      weekly_survey_reminder: true,
    }),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.code === 'AUTH_SESSION_CHANGED' &&
      error.kind === 'auth',
  );
  assert.deepEqual(authorizations, ['Bearer account-a-token']);
  assert.equal(refreshCalls, 1);
  assert.equal(client.getInMemoryAccessToken(), null);
});

test('T12 multipart 401 subject mismatch never uploads a second time as account B', async () => {
  const accountAId = '00000000-0000-4000-8000-00000000000a';
  const accountBId = '00000000-0000-4000-8000-00000000000b';
  const originalXmlHttpRequest = globalThis.XMLHttpRequest;
  const requests: Array<{ readonly headers: ReadonlyMap<string, string> }> = [];

  class FakeXmlHttpRequest {
    public readonly upload = { addEventListener: () => undefined };
    public status = 0;
    public responseText = '';
    private readonly headers = new Map<string, string>();
    private readonly listeners = new Map<string, Array<() => void>>();

    public open(): void {}

    public setRequestHeader(name: string, value: string): void {
      this.headers.set(name, value);
    }

    public addEventListener(name: string, listener: () => void): void {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    public send(): void {
      requests.push({ headers: new Map(this.headers) });
      this.status = 401;
      this.responseText = JSON.stringify({
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Expired.' },
      });
      queueMicrotask(() => this.listeners.get('load')?.forEach((listener) => listener()));
    }

    public abort(): void {
      this.listeners.get('abort')?.forEach((listener) => listener());
    }
  }

  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    writable: true,
    value: FakeXmlHttpRequest,
  });

  try {
    let refreshCalls = 0;
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/v1/auth/login') {
          return Response.json(session('account-a-token', accountAId));
        }
        if (url.pathname === '/api/v1/auth/refresh') {
          refreshCalls += 1;
          return Response.json(session('account-b-token', accountBId));
        }
        throw new Error(`Unexpected request ${url.pathname}`);
      },
    });

    await client.login('account-a@example.test', 'password-a');
    await assert.rejects(
      client.uploadChatPhoto('conversation-1', {
        file: new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }),
        idempotencyKey: 'upload-1',
      }),
      (error: unknown) =>
        error instanceof ApiRequestError &&
        error.code === 'AUTH_SESSION_CHANGED' &&
        error.kind === 'auth',
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.headers.get('Authorization'), 'Bearer account-a-token');
    assert.equal(refreshCalls, 1);
    assert.equal(client.getInMemoryAccessToken(), null);
  } finally {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      writable: true,
      value: originalXmlHttpRequest,
    });
  }
});

test('prepared account deletion stays bound to the token that confirmed it', async () => {
  const deletionAuthorizations: string[] = [];
  let nextLoginToken = 'account-a-token';
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/v1/auth/login') {
        const response = Response.json(session(nextLoginToken));
        nextLoginToken = 'account-b-token';
        return response;
      }

      if (url.pathname === '/api/v1/settings/account') {
        deletionAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  await client.login('account-a@example.test', 'password-a');
  const deleteConfirmedAccount = client.prepareAccountDeletion('DELETE');
  await client.login('account-b@example.test', 'password-b');
  await deleteConfirmedAccount();

  assert.deepEqual(deletionAuthorizations, ['Bearer account-a-token']);
  assert.equal(client.hasAccessToken(), false);
});

test('prepared account deletion never refreshes or retries with another subject', async () => {
  let deletionCalls = 0;
  let refreshCalls = 0;
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/v1/auth/login') {
        return Response.json(session('confirmed-account-token'));
      }

      if (url.pathname === '/api/v1/settings/account') {
        deletionCalls += 1;
        return Response.json(
          { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Expired.' } },
          { status: 401 },
        );
      }

      if (url.pathname === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        return Response.json(session('different-account-token'));
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  await client.login('confirmed@example.test', 'password');
  const deleteConfirmedAccount = client.prepareAccountDeletion('DELETE');

  await assert.rejects(
    deleteConfirmedAccount(),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.kind === 'auth' &&
      error.code === 'AUTHENTICATION_REQUIRED',
  );
  assert.equal(deletionCalls, 1);
  assert.equal(refreshCalls, 0);
});

test('prepared logout push cleanup stays bound to account A and never refreshes as account B', async () => {
  const deletionAuthorizations: string[] = [];
  let nextLoginToken = 'account-a-token';
  let refreshCalls = 0;
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));

      if (url.pathname === '/api/v1/auth/login') {
        const response = Response.json(session(nextLoginToken));
        nextLoginToken = 'account-b-token';
        return response;
      }

      if (url.pathname === '/api/v1/push/subscriptions') {
        deletionAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
        return Response.json(
          { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Expired.' } },
          { status: 401 },
        );
      }

      if (url.pathname === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        return Response.json(session('account-b-refreshed-token'));
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  await client.login('account-a@example.test', 'password-a');
  const deleteConfirmedAccountPush = client.preparePushSubscriptionDeletion();
  await client.login('account-b@example.test', 'password-b');

  await assert.rejects(
    deleteConfirmedAccountPush({ endpoint: 'https://push.example/account-a-device' }),
    (error: unknown) =>
      error instanceof ApiRequestError &&
      error.kind === 'auth' &&
      error.code === 'AUTHENTICATION_REQUIRED',
  );
  assert.deepEqual(deletionAuthorizations, ['Bearer account-a-token']);
  assert.equal(refreshCalls, 0);
});

test('onboarding completion uses an authenticated idempotent PUT endpoint', async () => {
  const calls: Array<{
    readonly path: string;
    readonly method: string;
    readonly authorization: string | null;
    readonly body: BodyInit | null | undefined;
  }> = [];

  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        body: init?.body,
      });

      if (url.pathname === '/api/v1/auth/refresh') {
        return Response.json(session('onboarding-token'));
      }

      if (url.pathname === '/api/v1/me/onboarding-complete') {
        return Response.json({
          ...profile,
          user: { ...profile.user, onboardingStatus: 'base_lessons' },
        });
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  assert.equal(await client.bootstrapSession(), true);
  const completed = await client.completeOnboarding();
  assert.equal(completed.user.onboardingStatus, 'base_lessons');
  assert.deepEqual(calls.at(-1), {
    path: '/api/v1/me/onboarding-complete',
    method: 'PUT',
    authorization: 'Bearer onboarding-token',
    body: undefined,
  });
});

test('trainer conversation summary client performs one exact authenticated GET', async () => {
  const conversationId = '91000000-0000-4000-8000-000000000123';
  const calls: Array<{
    readonly path: string;
    readonly method: string;
    readonly authorization: string | null;
    readonly signal: AbortSignal | null | undefined;
  }> = [];
  const controller = new AbortController();
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        signal: init?.signal,
      });

      if (url.pathname === '/api/v1/auth/refresh') {
        return Response.json(session('trainer-token'));
      }

      if (url.pathname === `/api/v1/chat/conversations/${conversationId}`) {
        return Response.json({
          conversation: {
            id: conversationId,
            client: {
              display_name: 'Точная клиентка',
              secondary_label: 't***@example.test',
              avatar_url: null,
            },
            last_message: null,
            unread_count: 0,
            activity_at: '2026-08-24T08:00:00.000Z',
          },
        });
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  assert.equal(await client.bootstrapSession(), true);
  const result = await client.getChatConversationSummary(conversationId, controller.signal);
  assert.equal(result.conversation.client.display_name, 'Точная клиентка');
  assert.deepEqual(calls.at(-1), {
    path: `/api/v1/chat/conversations/${conversationId}`,
    method: 'GET',
    authorization: 'Bearer trainer-token',
    signal: controller.signal,
  });
});
