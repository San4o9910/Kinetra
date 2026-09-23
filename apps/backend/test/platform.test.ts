import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WebhookAuthTokenDelivery } from '../src/auth/delivery.js';
import { createDatabaseReadinessCheck } from '../src/db/pool.js';
import { createShutdownHandler } from '../src/shutdown.js';

test('readiness deadline coalesces a stalled probe and recovers after settlement', async () => {
  let calls = 0;
  let finish: (() => void) | undefined;
  const check = createDatabaseReadinessCheck(() => {
    calls++;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  }, 10);
  assert.deepEqual(await Promise.all([check(), check(), check()]), [false, false, false]);
  assert.equal(calls, 1);
  finish?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = check();
  await new Promise<void>((resolve) => setImmediate(resolve));
  finish?.();
  assert.equal(await next, true);
  assert.equal(calls, 2);
  assert.equal(
    await createDatabaseReadinessCheck(async () => {
      throw new Error('private database details');
    }, 20)(),
    false,
  );
});

test('shutdown becomes unready immediately, is single flight and cleans database after earlier failure', async () => {
  const steps: string[] = [];
  const shutdown = createShutdownHandler({
    drainMs: 0,
    timeoutMs: 1000,
    markDraining: () => {
      steps.push('drain');
    },
    closeRealtime: async () => {
      steps.push('realtime');
      throw new Error('private details');
    },
    closeHttp: async () => {
      steps.push('http');
    },
    closeDatabase: async () => {
      steps.push('database');
    },
    reportFailure: (stage) => {
      steps.push(`failure:${stage}`);
    },
    forceExit: () => {
      steps.push('exit');
    },
  });
  const first = shutdown();
  assert.deepEqual(steps, ['drain']);
  assert.equal(shutdown(), first);
  await first;
  assert.deepEqual(steps, ['drain', 'realtime', 'failure:realtime', 'http', 'database']);
});

test('shutdown hard deadline invokes forced exit while a cleanup stage hangs', async () => {
  let complete: (() => void) | undefined;
  let observeExit: (() => void) | undefined;
  const exit = new Promise<void>((resolve) => {
    observeExit = resolve;
  });
  const failures: string[] = [];
  const shutdown = createShutdownHandler({
    drainMs: 0,
    timeoutMs: 10,
    markDraining: () => undefined,
    closeRealtime: () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    closeHttp: async () => undefined,
    closeDatabase: async () => undefined,
    reportFailure: (stage) => {
      failures.push(stage);
    },
    forceExit: () => {
      observeExit?.();
    },
  });
  const pending = shutdown();
  await exit;
  assert.deepEqual(failures, ['deadline']);
  complete?.();
  await pending;
});

test('webhook uses bounded POST with stable contract, excludes internal ID and cancels private response', async () => {
  let cancelled = false;
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://delivery.example.test/token');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-secret');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      version: 1,
      event: 'password_reset',
      recipient: { type: 'email', value: 'test@example.test' },
      token: 'synthetic-token',
      expiresAt: '2026-09-09T00:00:00.000Z',
    });
    return new Response(
      new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      }),
      { status: 202 },
    );
  };
  await new WebhookAuthTokenDelivery(
    { url: 'https://delivery.example.test/token', secret: 'synthetic-secret', timeoutMs: 1000 },
    request,
  ).sendPasswordReset({
    userId: 'must-not-be-sent',
    destination: 'test@example.test',
    destinationType: 'email',
    token: 'synthetic-token',
    expiresAt: new Date('2026-09-09T00:00:00Z'),
  });
  assert.equal(cancelled, true);
});

test('webhook failures never expose provider body or transport details', async () => {
  for (const request of [
    async () => {
      throw new Error('secret-header and token in transport error');
    },
    async () => new Response('private delivery response', { status: 503 }),
  ]) {
    const delivery = new WebhookAuthTokenDelivery(
      { url: 'https://delivery.example.test/token', secret: 'synthetic-secret', timeoutMs: 1000 },
      request,
    );
    await assert.rejects(
      delivery.sendEmailVerification({
        userId: 'private-id',
        email: 'test@example.test',
        token: 'secret-token',
        expiresAt: new Date(),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^Auth token delivery/u);
        assert.doesNotMatch(
          error.message,
          /secret-header|private delivery|secret-token|example\.test/u,
        );
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});
