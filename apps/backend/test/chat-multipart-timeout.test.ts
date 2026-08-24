import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { HttpError } from '../src/auth/errors.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import { ChatEventHub } from '../src/chat/event-hub.js';
import {
  ChatMediaError,
  ChatMultipartAdmissionController,
  readSinglePhotoMultipart,
} from '../src/chat/media.js';
import { NoopChatRateLimiter } from '../src/chat/rate-limit.js';
import { createChatRouter } from '../src/chat/router.js';
import { ChatService } from '../src/chat/service.js';
import {
  FakeChatImageProcessor,
  FakeChatMediaStore,
  FixedChatClock,
} from './support/fake-chat-media.js';
import { InMemoryChatRepository } from './support/in-memory-chat.repository.js';

const BOUNDARY = 'kinetra-timeout-boundary';
const VALID_PHOTO = Buffer.from('valid-photo-fixture');

const multipartBody = (bytes: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="photo"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`,
      'utf8',
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8'),
  ]);

const controlledRequest = (): PassThrough & Request => {
  const stream = new PassThrough() as PassThrough & Request;
  stream.get = ((name: string): string | undefined =>
    name.toLowerCase() === 'content-type'
      ? `multipart/form-data; boundary=${BOUNDARY}`
      : undefined) as Request['get'];
  return stream;
};

const timeoutError = (error: unknown): boolean =>
  error instanceof ChatMediaError &&
  error.statusCode === 408 &&
  error.code === 'CHAT_PHOTO_UPLOAD_TIMEOUT';

const withReferencedDeadline = async <T>(operation: () => Promise<T>): Promise<T> => {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(
      () => reject(new Error('multipart timeout test did not settle within 2 seconds')),
      2_000,
    );
  });

  try {
    return await Promise.race([operation(), watchdog]);
  } finally {
    if (deadline !== undefined) {
      clearTimeout(deadline);
    }
  }
};

test('multipart reader enforces idle deadlines before the first byte and between chunks', async () => {
  for (const writePrefix of [false, true]) {
    const request = controlledRequest();
    let accountedBytes = 0;
    const read = readSinglePhotoMultipart(
      request,
      (bytes) => {
        accountedBytes += bytes;
      },
      { idleTimeoutMs: 20, totalTimeoutMs: 200 },
    );

    if (writePrefix) {
      request.write(Buffer.from(`--${BOUNDARY}\r\n`, 'utf8'));
    }

    await withReferencedDeadline(() => assert.rejects(read, timeoutError));
    const bytesAtTimeout = accountedBytes;
    request.write(Buffer.from('late bytes'));
    await delay(10);
    assert.equal(accountedBytes, bytesAtTimeout, 'late chunks must not be accounted');
    assert.equal(request.listenerCount('data'), 0);
    assert.equal(request.listenerCount('end'), 0);
    assert.equal(request.listenerCount('aborted'), 0);
    request.destroy();
  }
});

test('multipart reader enforces total deadline against drip feeds and accepts bounded slow bodies', async () => {
  {
    const request = controlledRequest();
    const interval = setInterval(() => request.write(Buffer.from('x')), 10);
    interval.unref();

    try {
      await withReferencedDeadline(() =>
        assert.rejects(
          readSinglePhotoMultipart(request, undefined, {
            idleTimeoutMs: 30,
            totalTimeoutMs: 80,
          }),
          timeoutError,
        ),
      );
    } finally {
      clearInterval(interval);
      request.destroy();
    }
  }

  {
    const request = controlledRequest();
    const body = multipartBody(VALID_PHOTO);
    const read = readSinglePhotoMultipart(request, undefined, {
      idleTimeoutMs: 35,
      totalTimeoutMs: 250,
    });

    for (let offset = 0; offset < body.length; offset += 16) {
      request.write(body.subarray(offset, offset + 16));
      await delay(5);
    }
    request.end();

    const parsed = await read;
    assert.deepEqual(parsed.bytes, VALID_PHOTO);
    assert.equal(request.listenerCount('data'), 0);
    assert.equal(request.listenerCount('end'), 0);
    assert.equal(request.listenerCount('error'), 0);
    assert.equal(request.listenerCount('aborted'), 0);
  }
});

test('multipart reader settles once across client abort and an end/deadline boundary', async () => {
  {
    const request = controlledRequest();
    let accountedBytes = 0;
    const read = readSinglePhotoMultipart(
      request,
      (bytes) => {
        accountedBytes += bytes;
      },
      { idleTimeoutMs: 40, totalTimeoutMs: 200 },
    );
    request.write(Buffer.from('prefix'));
    request.emit('aborted');

    await assert.rejects(
      read,
      (error: unknown) =>
        error instanceof ChatMediaError &&
        error.statusCode === 400 &&
        error.code === 'CHAT_INVALID_REQUEST',
    );
    const bytesAtAbort = accountedBytes;
    request.write(Buffer.from('late'));
    request.end();
    assert.doesNotThrow(() => request.emit('error', new Error('late stream error')));
    request.destroy();
    await delay(50);
    assert.equal(accountedBytes, bytesAtAbort);
    assert.equal(request.listenerCount('data'), 0);
    assert.equal(request.listenerCount('aborted'), 0);
    assert.equal(request.listenerCount('error'), 0);
    assert.equal(request.listenerCount('close'), 0);
  }

  {
    const request = controlledRequest();
    const body = multipartBody(VALID_PHOTO);
    const read = readSinglePhotoMultipart(request, undefined, {
      idleTimeoutMs: 30,
      totalTimeoutMs: 100,
    });
    const outcome = read.then(
      (result) => {
        assert.deepEqual(result.bytes, VALID_PHOTO);
        return 'success' as const;
      },
      (error: unknown) => {
        assert.equal(timeoutError(error), true);
        return 'timeout' as const;
      },
    );
    setTimeout(() => request.end(body), 30);
    assert.equal(['success', 'timeout'].includes(await outcome), true);
    await delay(105);
    assert.equal(request.listenerCount('data'), 0, 'cleared timers must not re-enter success');
    request.destroy();
  }
});

interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly connection: string | undefined;
}

interface PartialUpload {
  readonly request: ClientRequest;
  readonly response: Promise<HttpResult>;
}

const collectResponse = (response: IncomingMessage): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.once('error', reject);
    response.once('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({
        status: response.statusCode ?? 0,
        body: text.length === 0 ? null : (JSON.parse(text) as unknown),
        connection: response.headers.connection,
      });
    });
  });

const openPartialUpload = (baseUrl: URL, conversationId: string, token: string): PartialUpload => {
  let resolveResponse!: (result: HttpResult) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<HttpResult>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = httpRequest(
    new URL(`/api/v1/chat/conversations/${conversationId}/photos`, baseUrl),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
        'Idempotency-Key': randomUUID(),
        'Transfer-Encoding': 'chunked',
      },
    },
  );
  request.once('response', (incoming) => {
    void collectResponse(incoming).then(resolveResponse, rejectResponse);
  });
  request.once('error', rejectResponse);
  request.flushHeaders();
  request.write(Buffer.from(`--${BOUNDARY}\r\n`, 'utf8'));
  return { request, response };
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

const waitForClientRequestClose = async (request: ClientRequest): Promise<void> => {
  if (request.destroyed) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for the server to close an upload request.')),
      1_000,
    );
    request.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

test('real HTTP multipart slots time out, close connections and recover capacity', async () => {
  const repository = new InMemoryChatRepository();
  const sessionId = randomUUID();
  repository.addSession(repository.clientId, sessionId);
  const clock = new FixedChatClock(new Date('2026-08-24T10:00:00.000Z'));
  const processor = new FakeChatImageProcessor();
  const store = new FakeChatMediaStore();
  const controller = new ChatMultipartAdmissionController(10);
  let reserveCalls = 0;
  let normalizeCalls = 0;
  let putCalls = 0;
  let failNormalization = false;
  const reservePhoto = repository.reservePhoto.bind(repository);
  const normalize = processor.normalize.bind(processor);
  const putObject = store.putObject.bind(store);
  repository.reservePhoto = async (input) => {
    reserveCalls += 1;
    return reservePhoto(input);
  };
  processor.normalize = async (input) => {
    normalizeCalls += 1;

    if (failNormalization) {
      throw new Error('Injected normalization failure.');
    }

    return normalize(input);
  };
  store.putObject = async (key, body) => {
    putCalls += 1;
    return putObject(key, body);
  };
  const service = new ChatService({
    repository,
    eventPublisher: new ChatEventHub(),
    rateLimiter: new NoopChatRateLimiter(),
    imageProcessor: processor,
    mediaStore: store,
    clock,
    enabled: true,
    photoUploadsEnabled: true,
    mediaUrlTtlSeconds: 300,
    cursorSecret: 'test-only-multipart-timeout-cursor-secret-32-bytes',
  });
  const tokens = new HmacJwtAccessTokenService(
    'test-only-multipart-access-secret-with-more-than-32-characters',
    'kinetra-multipart-test',
    'kinetra-multipart-pwa-test',
    900,
  );
  const token = (await tokens.issue(repository.clientId, sessionId, new Date())).token;
  const created = await repository.createOrGetConversation(repository.clientId, clock.now());
  assert.notEqual(created, null);
  const app = express();
  app.use(
    '/api/v1/chat',
    createChatRouter({
      service,
      authMiddleware: createAuthMiddleware(tokens),
      photoUploadIdleTimeoutMs: 150,
      photoUploadTotalTimeoutMs: 800,
      acquireMultipartSlot: () => controller.acquire(),
    }),
  );
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction): void => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: { code: error.code } });
      return;
    }

    response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  const server = (await import('node:http')).createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const baseUrl = new URL(`http://127.0.0.1:${(address as { port: number }).port}`);

  try {
    const partials = Array.from({ length: 10 }, () =>
      openPartialUpload(baseUrl, created!.conversation.id, token),
    );
    const capacityDeadline = Date.now() + 1_000;

    while (controller.activeCount < 10 && Date.now() < capacityDeadline) {
      await delay(5);
    }
    assert.equal(controller.activeCount, 10);

    const eleventh = openPartialUpload(baseUrl, created!.conversation.id, token);
    const overloaded = await eleventh.response;
    assert.equal(overloaded.status, 429);
    assert.equal((overloaded.body as { error: { code: string } }).error.code, 'CHAT_RATE_LIMITED');
    assert.equal(overloaded.connection, 'close');
    await waitForClientRequestClose(eleventh.request);

    const timedOut = await Promise.all(partials.map((partial) => partial.response));
    await Promise.all(partials.map((partial) => waitForClientRequestClose(partial.request)));
    assert.deepEqual(
      timedOut.map((result) => result.status),
      Array.from({ length: 10 }, () => 408),
    );
    assert.equal(
      timedOut.every(
        (result) =>
          (result.body as { error: { code: string } }).error.code === 'CHAT_PHOTO_UPLOAD_TIMEOUT' &&
          result.connection === 'close',
      ),
      true,
    );
    assert.equal(controller.activeCount, 0, 'every timed-out upload releases its slot once');
    assert.deepEqual(
      { reserveCalls, normalizeCalls, putCalls },
      { reserveCalls: 0, normalizeCalls: 0, putCalls: 0 },
    );

    const aborted = openPartialUpload(baseUrl, created!.conversation.id, token);
    void aborted.response.catch(() => undefined);
    const abortAdmissionDeadline = Date.now() + 500;

    while (controller.activeCount < 1 && Date.now() < abortAdmissionDeadline) {
      await delay(5);
    }
    assert.equal(controller.activeCount, 1);
    aborted.request.destroy();
    const abortReleaseDeadline = Date.now() + 500;

    while (controller.activeCount > 0 && Date.now() < abortReleaseDeadline) {
      await delay(5);
    }
    assert.equal(controller.activeCount, 0, 'client abort releases the multipart slot');
    assert.deepEqual(
      { reserveCalls, normalizeCalls, putCalls },
      { reserveCalls: 0, normalizeCalls: 0, putCalls: 0 },
    );

    failNormalization = true;
    const failedProcessingResponse = await fetch(
      new URL(`/api/v1/chat/conversations/${created!.conversation.id}/photos`, baseUrl),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Idempotency-Key': randomUUID(),
        },
        body: multipartBody(VALID_PHOTO),
      },
    );
    await failedProcessingResponse.body?.cancel();
    assert.equal(failedProcessingResponse.status, 500);
    assert.equal(controller.activeCount, 0, 'post-body service errors release the multipart slot');
    assert.deepEqual(
      { reserveCalls, normalizeCalls, putCalls },
      { reserveCalls: 1, normalizeCalls: 1, putCalls: 0 },
    );

    failNormalization = false;
    const validResponse = await fetch(
      new URL(`/api/v1/chat/conversations/${created!.conversation.id}/photos`, baseUrl),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          'Idempotency-Key': randomUUID(),
        },
        body: multipartBody(VALID_PHOTO),
      },
    );
    await validResponse.body?.cancel();
    assert.equal(validResponse.status, 201);
    assert.equal(controller.activeCount, 0);
    assert.deepEqual(
      { reserveCalls, normalizeCalls, putCalls },
      {
        reserveCalls: 2,
        normalizeCalls: 2,
        putCalls: 1,
      },
    );

    repository.revokeSession(repository.clientId, sessionId);
    const rejectedPreflight = openPartialUpload(baseUrl, created!.conversation.id, token);
    const unauthorized = await rejectedPreflight.response;
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.connection, 'close');
    await waitForClientRequestClose(rejectedPreflight.request);
    assert.equal(
      (unauthorized.body as { error: { code: string } }).error.code,
      'AUTHENTICATION_REQUIRED',
    );
    assert.equal(controller.activeCount, 0, 'failed preflight must not acquire a multipart slot');
    console.log('KINETRA_T12_MULTIPART_TIMEOUT=PASS');
  } finally {
    await closeServer(server);
  }
});
