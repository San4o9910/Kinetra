import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import { SignJWT } from 'jose';

import { createApp } from '../src/app.js';
import { BcryptPasswordHasher } from '../src/auth/password.js';
import { createFixedWindowRateLimiter } from '../src/auth/rate-limit.js';
import { AuthService, type AuthServiceConfig } from '../src/auth/service.js';
import {
  hashOpaqueToken,
  HmacJwtAccessTokenService,
  OpaqueTokenService,
} from '../src/auth/tokens.js';
import type { AuthRuntime } from '../src/auth/runtime.js';
import { CapturingAuthTokenDelivery } from './support/test-delivery.js';
import { MutableClock } from './support/test-clock.js';
import { InMemoryAuthRepository } from './support/in-memory-auth.repository.js';

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
  readonly cookie: string | null;
}

interface TestHarness {
  readonly baseUrl: string;
  readonly repository: InMemoryAuthRepository;
  readonly delivery: CapturingAuthTokenDelivery;
  readonly clock: MutableClock;
  readonly accessTokens: HmacJwtAccessTokenService;
  close(): Promise<void>;
}

interface HarnessOptions {
  readonly auth?: Partial<AuthServiceConfig>;
  readonly clockNow?: Date;
  readonly resetRateLimitMax?: number;
}

const ACCESS_TOKEN_SECRET = 'test-only-kinetra-access-secret-with-more-than-32-characters';
const ACCESS_TOKEN_ISSUER = 'kinetra-test';
const ACCESS_TOKEN_AUDIENCE = 'kinetra-pwa-test';
const ACCESS_TOKEN_TTL_SECONDS = 900;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

const defaultAuthConfig: AuthServiceConfig = {
  phoneLoginEnabled: true,
  phoneOnlyRegistrationEnabled: false,
  emailVerificationRequired: false,
  passwordMinimumLength: 10,
  refreshTtlMs: 30 * 24 * 60 * 60 * 1000,
  passwordResetTtlMs: 15 * 60 * 1000,
  emailVerificationTtlMs: 24 * 60 * 60 * 1000,
};

const asObject = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
};

const readString = (object: Record<string, unknown>, key: string): string => {
  const value = object[key];
  assert.equal(typeof value, 'string');
  return value as string;
};

const errorCode = (body: unknown): string => {
  const error = asObject(asObject(body).error);
  return readString(error, 'code');
};

const cookieValue = (cookie: string): string => {
  const separatorIndex = cookie.indexOf('=');
  assert.notEqual(separatorIndex, -1);
  return decodeURIComponent(cookie.slice(separatorIndex + 1));
};

const tamperJwtSignature = (token: string): string => {
  const parts = token.split('.');
  assert.equal(parts.length, 3);
  const signature = parts[2];
  assert.notEqual(signature, undefined);
  assert.notEqual(signature, '');
  const replacement = signature?.startsWith('A') === true ? 'B' : 'A';
  return `${parts[0]}.${parts[1]}.${replacement}${signature?.slice(1) ?? ''}`;
};

const signNoncanonicalAccessProof = async (
  userId: string,
  issuedAt: number,
  expiresAt: number,
): Promise<string> =>
  new SignJWT({ sid: randomUUID(), type: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(ACCESS_TOKEN_SECRET));

const startHarness = async (options: HarnessOptions = {}): Promise<TestHarness> => {
  const repository = new InMemoryAuthRepository();
  const delivery = new CapturingAuthTokenDelivery();
  const clock = new MutableClock(options.clockNow ?? new Date('2026-08-19T08:00:00.000Z'));
  const authConfig = { ...defaultAuthConfig, ...options.auth };
  const accessTokens = new HmacJwtAccessTokenService(
    ACCESS_TOKEN_SECRET,
    ACCESS_TOKEN_ISSUER,
    ACCESS_TOKEN_AUDIENCE,
    ACCESS_TOKEN_TTL_SECONDS,
  );
  const service = new AuthService({
    repository,
    passwordHasher: new BcryptPasswordHasher(4),
    opaqueTokens: new OpaqueTokenService(),
    accessTokens,
    tokenDelivery: delivery,
    clock,
    config: authConfig,
  });
  const runtime: AuthRuntime = {
    service,
    accessTokenVerifier: accessTokens,
    refreshCookie: {
      name: 'kinetra_refresh_test',
      secure: false,
      sameSite: 'lax',
      maxAgeMs: authConfig.refreshTtlMs,
    },
    passwordResetRateLimiter: createFixedWindowRateLimiter({
      windowMs: 60_000,
      maximumRequests: options.resetRateLimitMax ?? 50,
    }),
  };
  const server = createServer(createApp({ authRuntime: runtime }));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    repository,
    delivery,
    clock,
    accessTokens,
    close: () => closeServer(server),
  };
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
};

const postJson = async (
  harness: TestHarness,
  path: string,
  body: unknown,
  cookie?: string,
  authorization?: string,
): Promise<ApiResult> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }

  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();

  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? null,
  };
};

const registerEmailUser = async (harness: TestHarness): Promise<ApiResult> =>
  postJson(harness, '/api/v1/auth/register', {
    email: 'athlete@example.com',
    password: 'StrongPass123',
  });

test('email registration and login use bcrypt and reject a wrong password', async () => {
  const harness = await startHarness();

  try {
    const registration = await postJson(harness, '/api/v1/auth/register', {
      email: ' Athlete@Example.COM ',
      password: 'StrongPass123',
    });
    assert.equal(registration.status, 201);
    assert.notEqual(registration.cookie, null);
    const registrationBody = asObject(registration.body);
    const publicUser = asObject(registrationBody.user);
    assert.equal(publicUser.email, 'athlete@example.com');
    assert.equal(JSON.stringify(registration.body).includes('StrongPass123'), false);
    assert.equal(JSON.stringify(registration.body).includes('passwordHash'), false);

    const storedUser = harness.repository.peekUserByEmail('athlete@example.com');
    assert.notEqual(storedUser, null);
    assert.notEqual(storedUser?.passwordHash, 'StrongPass123');
    assert.equal(storedUser?.passwordHash.startsWith('$2'), true);

    const accessToken = readString(registrationBody, 'accessToken');
    const claims = await harness.accessTokens.verify(accessToken, harness.clock.now());
    assert.equal(claims.sub, storedUser?.id);

    const wrongPassword = await postJson(harness, '/api/v1/auth/login', {
      email: 'athlete@example.com',
      password: 'WrongPass123',
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(errorCode(wrongPassword.body), 'INVALID_CREDENTIALS');

    const login = await postJson(harness, '/api/v1/auth/login', {
      identifier: 'ATHLETE@example.com',
      password: 'StrongPass123',
    });
    assert.equal(login.status, 200);
    assert.notEqual(login.cookie, null);
  } finally {
    await harness.close();
  }
});

test('unexpected database errors are logged without PostgreSQL details or row values', async () => {
  const harness = await startHarness();
  const sensitiveDetail = 'Failing row contains private trainer chat message text.';
  const databaseError = Object.assign(new Error('violates check constraint'), {
    code: '23514',
    detail: sensitiveDetail,
    query: 'INSERT INTO chat_messages (body) VALUES (private trainer chat message text)',
  });
  const originalCreateUser = harness.repository.createUser.bind(harness.repository);
  const originalConsoleError = console.error;
  const capturedLogs: unknown[][] = [];

  harness.repository.createUser = async () => {
    throw databaseError;
  };
  console.error = (...values: unknown[]): void => {
    capturedLogs.push(values);
  };

  try {
    const response = await fetch(`${harness.baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'redacted-error-regression',
      },
      body: JSON.stringify({
        email: 'logger-regression@example.com',
        password: 'StrongPass123',
      }),
    });

    assert.equal(response.status, 500);
    const responseBody = asObject(await response.json());
    assert.equal(errorCode(responseBody), 'INTERNAL_ERROR');
    const serializedLogs = JSON.stringify(capturedLogs);
    assert.equal(serializedLogs.includes('redacted-error-regression'), true);
    assert.equal(serializedLogs.includes('23514'), true);
    assert.equal(serializedLogs.includes(sensitiveDetail), false);
    assert.equal(serializedLogs.includes('private trainer chat message text'), false);
    assert.equal(serializedLogs.includes('violates check constraint'), false);
  } finally {
    harness.repository.createUser = originalCreateUser;
    console.error = originalConsoleError;
    await harness.close();
  }
});

test('phone-only registration is configuration-gated and phone can be an alternative login', async () => {
  const defaultHarness = await startHarness();

  try {
    const rejected = await postJson(defaultHarness, '/api/v1/auth/register', {
      phone: '+7 (999) 123-45-67',
      password: 'StrongPass123',
    });
    assert.equal(rejected.status, 400);
    assert.equal(errorCode(rejected.body), 'EMAIL_REQUIRED');

    const alternative = await postJson(defaultHarness, '/api/v1/auth/register', {
      email: 'phone-alt@example.com',
      phone: '+7 (999) 111-22-33',
      password: 'StrongPass123',
    });
    assert.equal(alternative.status, 201);
    const alternativeLogin = await postJson(defaultHarness, '/api/v1/auth/login', {
      phone: '+79991112233',
      password: 'StrongPass123',
    });
    assert.equal(alternativeLogin.status, 200);
  } finally {
    await defaultHarness.close();
  }

  const phoneOnlyHarness = await startHarness({
    auth: { phoneOnlyRegistrationEnabled: true },
  });

  try {
    const registration = await postJson(phoneOnlyHarness, '/api/v1/auth/register', {
      phone: '+7 (999) 123-45-67',
      password: 'StrongPass123',
    });
    assert.equal(registration.status, 201);
    assert.equal(asObject(asObject(registration.body).user).phone, '+79991234567');

    const login = await postJson(phoneOnlyHarness, '/api/v1/auth/login', {
      identifier: '+7 999 123 45 67',
      password: 'StrongPass123',
    });
    assert.equal(login.status, 200);
  } finally {
    await phoneOnlyHarness.close();
  }
});

test('refresh rotation detects reuse and logout revokes the current session', async () => {
  const harness = await startHarness();

  try {
    const registration = await registerEmailUser(harness);
    assert.equal(registration.status, 201);
    assert.notEqual(registration.cookie, null);
    const firstCookie = registration.cookie as string;

    const rotated = await postJson(harness, '/api/v1/auth/refresh', {}, firstCookie);
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.cookie, null);
    const secondCookie = rotated.cookie as string;
    assert.notEqual(secondCookie, firstCookie);

    const reusedOldToken = await postJson(harness, '/api/v1/auth/refresh', {}, firstCookie);
    assert.equal(reusedOldToken.status, 401);
    assert.equal(errorCode(reusedOldToken.body), 'INVALID_REFRESH_TOKEN');

    const replacementWasRevoked = await postJson(harness, '/api/v1/auth/refresh', {}, secondCookie);
    assert.equal(replacementWasRevoked.status, 401);

    const login = await postJson(harness, '/api/v1/auth/login', {
      email: 'athlete@example.com',
      password: 'StrongPass123',
    });
    assert.equal(login.status, 200);
    assert.notEqual(login.cookie, null);
    const loginCookie = login.cookie as string;
    const loginAccessToken = readString(asObject(login.body), 'accessToken');

    const logout = await postJson(
      harness,
      '/api/v1/auth/logout',
      {},
      loginCookie,
      `Bearer ${loginAccessToken}`,
    );
    assert.equal(logout.status, 204);
    assert.equal(logout.cookie, null);
    const storedSession = harness.repository.peekRefreshSession(
      hashOpaqueToken(cookieValue(loginCookie)),
    );
    assert.notEqual(storedSession?.revokedAt, null);

    const refreshAfterLogout = await postJson(harness, '/api/v1/auth/refresh', {}, loginCookie);
    assert.equal(refreshAfterLogout.status, 401);
  } finally {
    await harness.close();
  }
});

test('day-zero logout proof revokes only its day-31 sliding refresh family', async () => {
  const verifierNow = new Date();
  const harness = await startHarness({
    clockNow: new Date(verifierNow.getTime() - 31 * DAY_IN_MILLISECONDS),
  });

  try {
    const registration = await registerEmailUser(harness);
    assert.equal(registration.status, 201);
    assert.notEqual(registration.cookie, null);
    const dayZeroCookie = registration.cookie as string;
    const dayZeroProof = readString(asObject(registration.body), 'accessToken');

    harness.clock.advance(29 * DAY_IN_MILLISECONDS);
    const rotatedFamily = await postJson(harness, '/api/v1/auth/refresh', {}, dayZeroCookie);
    assert.equal(rotatedFamily.status, 200);
    assert.notEqual(rotatedFamily.cookie, null);
    const dayTwentyNineCookie = rotatedFamily.cookie as string;

    const unrelatedFamily = await postJson(harness, '/api/v1/auth/login', {
      email: 'athlete@example.com',
      password: 'StrongPass123',
    });
    assert.equal(unrelatedFamily.status, 200);
    assert.notEqual(unrelatedFamily.cookie, null);
    const unrelatedFamilyCookie = unrelatedFamily.cookie as string;

    const otherAccount = await postJson(harness, '/api/v1/auth/register', {
      email: 'logout-family-other@example.com',
      password: 'StrongPass123',
    });
    assert.equal(otherAccount.status, 201);
    assert.notEqual(otherAccount.cookie, null);
    const otherAccountCookie = otherAccount.cookie as string;

    harness.clock.advance(2 * DAY_IN_MILLISECONDS);
    await assert.rejects(harness.accessTokens.verify(dayZeroProof, harness.clock.now()));

    const unrelatedFamilyLogout = await postJson(
      harness,
      '/api/v1/auth/logout',
      {},
      unrelatedFamilyCookie,
      `Bearer ${dayZeroProof}`,
    );
    assert.equal(unrelatedFamilyLogout.status, 409);
    assert.equal(errorCode(unrelatedFamilyLogout.body), 'LOGOUT_NOT_CONFIRMED');
    assert.equal(unrelatedFamilyLogout.cookie, null);

    const otherAccountLogout = await postJson(
      harness,
      '/api/v1/auth/logout',
      {},
      otherAccountCookie,
      `Bearer ${dayZeroProof}`,
    );
    assert.equal(otherAccountLogout.status, 409);
    assert.equal(errorCode(otherAccountLogout.body), 'LOGOUT_NOT_CONFIRMED');
    assert.equal(otherAccountLogout.cookie, null);

    const remoteRefreshWonRace = await postJson(
      harness,
      '/api/v1/auth/refresh',
      {},
      dayTwentyNineCookie,
    );
    assert.equal(remoteRefreshWonRace.status, 200);
    assert.notEqual(remoteRefreshWonRace.cookie, null);
    const remoteReplacementCookie = remoteRefreshWonRace.cookie as string;
    const secondRemoteRefreshWonRace = await postJson(
      harness,
      '/api/v1/auth/refresh',
      {},
      remoteReplacementCookie,
    );
    assert.equal(secondRemoteRefreshWonRace.status, 200);
    assert.notEqual(secondRemoteRefreshWonRace.cookie, null);
    const latestRemoteReplacementCookie = secondRemoteRefreshWonRace.cookie as string;

    const logout = await postJson(
      harness,
      '/api/v1/auth/logout',
      {},
      dayTwentyNineCookie,
      `Bearer ${dayZeroProof}`,
    );
    assert.equal(logout.status, 204);
    assert.equal(logout.cookie, null, 'family-bound logout must never emit Set-Cookie');
    assert.notEqual(
      harness.repository.peekRefreshSession(hashOpaqueToken(cookieValue(dayTwentyNineCookie)))
        ?.revokedAt,
      null,
    );
    assert.notEqual(
      harness.repository.peekRefreshSession(hashOpaqueToken(cookieValue(remoteReplacementCookie)))
        ?.revokedAt,
      null,
      'a refresh-first replacement descendant must be revoked by the queued family logout',
    );
    assert.notEqual(
      harness.repository.peekRefreshSession(
        hashOpaqueToken(cookieValue(latestRemoteReplacementCookie)),
      )?.revokedAt,
      null,
      'family logout must follow and revoke replacement descendants beyond one hop',
    );

    const refreshAfterLogout = await postJson(
      harness,
      '/api/v1/auth/refresh',
      {},
      latestRemoteReplacementCookie,
    );
    assert.equal(refreshAfterLogout.status, 401);

    const unrelatedFamilySurvives = await postJson(
      harness,
      '/api/v1/auth/refresh',
      {},
      unrelatedFamilyCookie,
    );
    assert.equal(unrelatedFamilySurvives.status, 200);

    const otherAccountSurvives = await postJson(
      harness,
      '/api/v1/auth/refresh',
      {},
      otherAccountCookie,
    );
    assert.equal(otherAccountSurvives.status, 200);
  } finally {
    await harness.close();
  }
});

test('logout rejects tampered, future-issued, and noncanonical subject proofs', async () => {
  const harness = await startHarness();

  try {
    const registration = await registerEmailUser(harness);
    assert.equal(registration.status, 201);
    assert.notEqual(registration.cookie, null);
    const refreshCookie = registration.cookie as string;
    const refreshHash = hashOpaqueToken(cookieValue(refreshCookie));
    const userId = readString(asObject(asObject(registration.body).user), 'id');
    const verifierNow = new Date();
    const issuedProof = readString(asObject(registration.body), 'accessToken');
    const verifierNowSeconds = Math.floor(verifierNow.getTime() / 1_000);
    const futureIssuedProof = await signNoncanonicalAccessProof(
      userId,
      verifierNowSeconds + 60,
      verifierNowSeconds + 60 + ACCESS_TOKEN_TTL_SECONDS,
    );
    const noncanonicalTtlProof = await signNoncanonicalAccessProof(
      userId,
      verifierNowSeconds - 60,
      verifierNowSeconds - 60 + ACCESS_TOKEN_TTL_SECONDS - 1,
    );

    for (const invalidProof of [
      tamperJwtSignature(issuedProof),
      futureIssuedProof,
      noncanonicalTtlProof,
    ]) {
      const rejectedLogout = await postJson(
        harness,
        '/api/v1/auth/logout',
        {},
        refreshCookie,
        `Bearer ${invalidProof}`,
      );
      assert.equal(rejectedLogout.status, 401);
      assert.equal(rejectedLogout.cookie, null);
      assert.equal(harness.repository.peekRefreshSession(refreshHash)?.revokedAt, null);
    }

    const refreshAfterRejectedProofs = await postJson(
      harness,
      '/api/v1/auth/refresh',
      {},
      refreshCookie,
    );
    assert.equal(refreshAfterRejectedProofs.status, 200);
  } finally {
    await harness.close();
  }
});

test('subject-bound logout never revokes or clears another tab account refresh cookie', async () => {
  const harness = await startHarness();

  try {
    const accountA = await postJson(harness, '/api/v1/auth/register', {
      email: 'account-a@example.test',
      password: 'StrongPass123',
    });
    const accountB = await postJson(harness, '/api/v1/auth/register', {
      email: 'account-b@example.test',
      password: 'StrongPass123',
    });
    assert.equal(accountA.status, 201);
    assert.equal(accountB.status, 201);
    assert.notEqual(accountA.cookie, null);
    assert.notEqual(accountB.cookie, null);
    const accountAAccessToken = readString(asObject(accountA.body), 'accessToken');
    const accountACookie = accountA.cookie as string;
    const accountBCookie = accountB.cookie as string;

    const mismatchedLogout = await postJson(
      harness,
      '/api/v1/auth/logout',
      {},
      accountBCookie,
      `Bearer ${accountAAccessToken}`,
    );
    assert.equal(mismatchedLogout.status, 409);
    assert.equal(errorCode(mismatchedLogout.body), 'LOGOUT_NOT_CONFIRMED');
    assert.equal(
      mismatchedLogout.cookie,
      null,
      'a subject mismatch must not emit a cookie-clearing Set-Cookie header',
    );
    assert.equal(
      harness.repository.peekRefreshSession(hashOpaqueToken(cookieValue(accountBCookie)))
        ?.revokedAt,
      null,
    );

    const matchingLogout = await postJson(
      harness,
      '/api/v1/auth/logout',
      {},
      accountACookie,
      `Bearer ${accountAAccessToken}`,
    );
    assert.equal(matchingLogout.status, 204);
    assert.equal(
      matchingLogout.cookie,
      null,
      'a late bearer-bound logout response must not clear a newer account cookie',
    );
    assert.notEqual(
      harness.repository.peekRefreshSession(hashOpaqueToken(cookieValue(accountACookie)))
        ?.revokedAt,
      null,
    );

    const accountBRefresh = await postJson(harness, '/api/v1/auth/refresh', {}, accountBCookie);
    assert.equal(accountBRefresh.status, 200);
  } finally {
    await harness.close();
  }
});

test('bearerless late logout is a no-op and never emits Set-Cookie', async () => {
  const harness = await startHarness();

  try {
    await postJson(harness, '/api/v1/auth/register', {
      email: 'legacy-account-a@example.test',
      password: 'StrongPass123',
    });
    const newerAccount = await postJson(harness, '/api/v1/auth/register', {
      email: 'legacy-account-b@example.test',
      password: 'StrongPass123',
    });
    assert.equal(newerAccount.status, 201);
    assert.notEqual(newerAccount.cookie, null);
    const newerAccountCookie = newerAccount.cookie as string;

    const lateLegacyLogout = await postJson(harness, '/api/v1/auth/logout', {}, newerAccountCookie);
    assert.equal(lateLegacyLogout.status, 204);
    assert.equal(lateLegacyLogout.cookie, null, 'bearerless logout must never emit Set-Cookie');
    assert.equal(
      harness.repository.peekRefreshSession(hashOpaqueToken(cookieValue(newerAccountCookie)))
        ?.revokedAt,
      null,
    );

    const newerAccountRefresh = await postJson(
      harness,
      '/api/v1/auth/refresh',
      {},
      newerAccountCookie,
    );
    assert.equal(newerAccountRefresh.status, 200);
  } finally {
    await harness.close();
  }
});

test('password reset is non-enumerating, one-time, hashed, and revokes refresh sessions', async () => {
  const harness = await startHarness();

  try {
    const registration = await registerEmailUser(harness);
    assert.notEqual(registration.cookie, null);
    const originalCookie = registration.cookie as string;

    const knownAccount = await postJson(harness, '/api/v1/auth/password-reset/request', {
      email: 'athlete@example.com',
    });
    const unknownAccount = await postJson(harness, '/api/v1/auth/password-reset/request', {
      email: 'missing@example.com',
    });
    assert.equal(knownAccount.status, 202);
    assert.equal(unknownAccount.status, 202);
    assert.deepEqual(knownAccount.body, unknownAccount.body);
    assert.equal(harness.delivery.passwordResets.length, 1);

    const resetToken = harness.delivery.passwordResets[0]?.token;
    assert.equal(typeof resetToken, 'string');
    const storedToken = harness.repository.peekPasswordResetToken(
      hashOpaqueToken(resetToken as string),
    );
    assert.notEqual(storedToken, null);
    assert.notEqual(storedToken?.tokenHash, resetToken);

    const confirmed = await postJson(harness, '/api/v1/auth/password-reset/confirm', {
      token: resetToken,
      newPassword: 'NewStrongPass456',
    });
    assert.equal(confirmed.status, 200);

    const reused = await postJson(harness, '/api/v1/auth/password-reset/confirm', {
      token: resetToken,
      newPassword: 'AnotherPass789',
    });
    assert.equal(reused.status, 400);
    assert.equal(errorCode(reused.body), 'INVALID_OR_EXPIRED_RESET_TOKEN');

    const oldSession = await postJson(harness, '/api/v1/auth/refresh', {}, originalCookie);
    assert.equal(oldSession.status, 401);

    const oldPassword = await postJson(harness, '/api/v1/auth/login', {
      email: 'athlete@example.com',
      password: 'StrongPass123',
    });
    assert.equal(oldPassword.status, 401);

    const newPassword = await postJson(harness, '/api/v1/auth/login', {
      email: 'athlete@example.com',
      password: 'NewStrongPass456',
    });
    assert.equal(newPassword.status, 200);
  } finally {
    await harness.close();
  }
});

test('expired password-reset tokens are rejected', async () => {
  const harness = await startHarness();

  try {
    await registerEmailUser(harness);
    await postJson(harness, '/api/v1/auth/password-reset/request', {
      email: 'athlete@example.com',
    });
    const resetToken = harness.delivery.passwordResets[0]?.token;
    assert.equal(typeof resetToken, 'string');
    harness.clock.advance(16 * 60 * 1000);

    const expired = await postJson(harness, '/api/v1/auth/password-reset/confirm', {
      token: resetToken,
      newPassword: 'NewStrongPass456',
    });
    assert.equal(expired.status, 400);
    assert.equal(errorCode(expired.body), 'INVALID_OR_EXPIRED_RESET_TOKEN');
  } finally {
    await harness.close();
  }
});

test('optional email verification blocks login until the one-time token is consumed', async () => {
  const harness = await startHarness({
    auth: { emailVerificationRequired: true },
  });

  try {
    const registration = await registerEmailUser(harness);
    assert.equal(registration.status, 201);
    assert.equal(registration.cookie, null);
    assert.equal(asObject(registration.body).emailVerificationRequired, true);
    assert.equal(harness.delivery.emailVerifications.length, 1);

    const blockedLogin = await postJson(harness, '/api/v1/auth/login', {
      email: 'athlete@example.com',
      password: 'StrongPass123',
    });
    assert.equal(blockedLogin.status, 403);
    assert.equal(errorCode(blockedLogin.body), 'EMAIL_NOT_VERIFIED');

    const verificationToken = harness.delivery.emailVerifications[0]?.token;
    assert.equal(typeof verificationToken, 'string');
    const verified = await postJson(harness, '/api/v1/auth/verify-email', {
      token: verificationToken,
    });
    assert.equal(verified.status, 200);
    assert.notEqual(verified.cookie, null);

    const reused = await postJson(harness, '/api/v1/auth/verify-email', {
      token: verificationToken,
    });
    assert.equal(reused.status, 400);

    const login = await postJson(harness, '/api/v1/auth/login', {
      email: 'athlete@example.com',
      password: 'StrongPass123',
    });
    assert.equal(login.status, 200);
  } finally {
    await harness.close();
  }
});

test('access JWT rejects tampering and expires after its short TTL', async () => {
  const harness = await startHarness();

  try {
    const registration = await registerEmailUser(harness);
    const accessToken = readString(asObject(registration.body), 'accessToken');
    const signatureStart = accessToken.lastIndexOf('.') + 1;
    const signatureCharacter = accessToken[signatureStart];
    assert.notEqual(signatureCharacter, undefined);
    const tamperedToken = `${accessToken.slice(0, signatureStart)}${
      signatureCharacter === 'A' ? 'B' : 'A'
    }${accessToken.slice(signatureStart + 1)}`;

    await assert.rejects(() => harness.accessTokens.verify(tamperedToken, harness.clock.now()));
    await assert.rejects(() =>
      harness.accessTokens.verify(
        accessToken,
        new Date(harness.clock.now().getTime() + 16 * 60 * 1000),
      ),
    );
  } finally {
    await harness.close();
  }
});

test('password-reset request is rate-limited and request bodies cannot override user identity', async () => {
  const harness = await startHarness({ resetRateLimitMax: 2 });

  try {
    const injectedUserId = await postJson(harness, '/api/v1/auth/register', {
      userId: 'attacker-controlled-id',
      email: 'attacker@example.com',
      password: 'StrongPass123',
    });
    assert.equal(injectedUserId.status, 400);
    assert.equal(errorCode(injectedUserId.body), 'USER_ID_NOT_ALLOWED');

    const first = await postJson(harness, '/api/v1/auth/password-reset/request', {
      email: 'missing@example.com',
    });
    const second = await postJson(harness, '/api/v1/auth/password-reset/request', {
      email: 'missing@example.com',
    });
    const third = await postJson(harness, '/api/v1/auth/password-reset/request', {
      email: 'missing@example.com',
    });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(third.status, 429);
    assert.equal(errorCode(third.body), 'RATE_LIMITED');
  } finally {
    await harness.close();
  }
});
