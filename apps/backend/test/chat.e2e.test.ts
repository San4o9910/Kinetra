import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { HttpError } from '../src/auth/errors.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import { ChatEventHub } from '../src/chat/event-hub.js';
import {
  InMemoryChatRateLimiter,
  NoopChatRateLimiter,
  type ChatRateLimiter,
} from '../src/chat/rate-limit.js';
import { createChatRouter } from '../src/chat/router.js';
import { ChatService } from '../src/chat/service.js';
import {
  FakeChatImageProcessor,
  FakeChatMediaStore,
  FixedChatClock,
} from './support/fake-chat-media.js';
import { InMemoryChatRepository } from './support/in-memory-chat.repository.js';

interface Harness {
  readonly baseUrl: string;
  readonly repository: InMemoryChatRepository;
  readonly clientToken: string;
  readonly trainerToken: string;
  readonly otherTrainerToken: string;
  readonly eventHub: ChatEventHub;
  close(): Promise<void>;
}

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

const startHarness = async (
  photoUploadsEnabled = true,
  rateLimiter: ChatRateLimiter = new NoopChatRateLimiter(),
): Promise<Harness> => {
  const repository = new InMemoryChatRepository();
  const clock = new FixedChatClock(new Date('2026-08-23T10:00:00.000Z'));
  const eventHub = new ChatEventHub();
  const service = new ChatService({
    repository,
    eventPublisher: eventHub,
    rateLimiter,
    imageProcessor: new FakeChatImageProcessor(),
    mediaStore: new FakeChatMediaStore(),
    clock,
    enabled: true,
    photoUploadsEnabled,
    mediaUrlTtlSeconds: 300,
    cursorSecret: 'test-only-chat-cursor-secret-with-32-bytes',
  });
  const tokens = new HmacJwtAccessTokenService(
    'test-only-chat-access-secret-with-more-than-32-characters',
    'kinetra-chat-test',
    'kinetra-chat-pwa-test',
    900,
  );
  const clientSessionId = randomUUID();
  const trainerSessionId = randomUUID();
  const otherTrainerId = randomUUID();
  const otherTrainerSessionId = randomUUID();
  repository.addActor({
    userId: otherTrainerId,
    role: 'trainer',
    onboardingStatus: 'survey_pending',
    displayName: 'Другой тренер',
    avatarUrl: null,
  });
  repository.addSession(repository.clientId, clientSessionId);
  repository.addSession(repository.trainerId, trainerSessionId);
  repository.addSession(otherTrainerId, otherTrainerSessionId);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/api/v1/chat',
    createChatRouter({ service, authMiddleware: createAuthMiddleware(tokens) }),
  );
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction): void => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
  });
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Chat test server did not expose a TCP address.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    repository,
    clientToken: (await tokens.issue(repository.clientId, clientSessionId, new Date())).token,
    trainerToken: (await tokens.issue(repository.trainerId, trainerSessionId, new Date())).token,
    otherTrainerToken: (await tokens.issue(otherTrainerId, otherTrainerSessionId, new Date()))
      .token,
    eventHub,
    close: () => closeServer(server),
  };
};

const jsonRequest = async (
  harness: Harness,
  path: string,
  options: {
    readonly method?: string;
    readonly token?: string | null;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
) => {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');

  if (options.token !== null) {
    headers.set('Authorization', `Bearer ${options.token ?? harness.clientToken}`);
  }

  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
    cacheControl: response.headers.get('cache-control'),
  };
};

const rawPhotoMultipart = (boundary: string, bytes: Buffer, complete: boolean): Buffer => {
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`,
    'utf8',
  );
  const suffix = complete ? Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8') : Buffer.alloc(0);
  return Buffer.concat([prefix, bytes, suffix]);
};

const postRawPhoto = async (
  harness: Harness,
  conversationId: string,
  boundary: string,
  body: Buffer,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(
    `${harness.baseUrl}/api/v1/chat/conversations/${conversationId}/photos`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${harness.clientToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Idempotency-Key': randomUUID(),
      },
      body,
    },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? null : (JSON.parse(text) as unknown),
  };
};

const asRecord = (value: unknown): Record<string, unknown> => {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
};

test('chat REST requires a live JWT session and returns private no-store responses', async () => {
  const harness = await startHarness();

  try {
    const missing = await jsonRequest(harness, '/api/v1/chat/session', { token: null });
    assert.equal(missing.status, 401);
    assert.equal(missing.cacheControl, 'no-store');

    const session = await jsonRequest(harness, '/api/v1/chat/session');
    assert.equal(session.status, 200);
    assert.deepEqual(session.body, {
      role: 'client',
      enabled: true,
      photo_uploads_enabled: true,
      available: true,
      conversation: null,
    });

    harness.repository.setDefaultTrainerActive(false);
    const unavailable = await jsonRequest(harness, '/api/v1/chat/session');
    assert.equal(asRecord(unavailable.body).available, false);
    harness.repository.setDefaultTrainerActive(true);
  } finally {
    await harness.close();
  }

  const photosDisabledHarness = await startHarness(false);

  try {
    const session = await jsonRequest(photosDisabledHarness, '/api/v1/chat/session');
    assert.equal(session.status, 200);
    assert.equal(asRecord(session.body).photo_uploads_enabled, false);
  } finally {
    await photosDisabledHarness.close();
  }
});

test('active client chat is available without any Premium subscription', async () => {
  const harness = await startHarness();

  try {
    const session = await jsonRequest(harness, '/api/v1/chat/session');
    assert.equal(session.status, 200);
    assert.equal('subscription' in asRecord(session.body), false);

    const created = await jsonRequest(harness, '/api/v1/chat/conversations', {
      method: 'POST',
      body: {},
    });
    assert.equal(created.status, 201);
    const conversationId = String(asRecord(asRecord(created.body).conversation).id);
    const sent = await jsonRequest(
      harness,
      `/api/v1/chat/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: {
          client_message_id: randomUUID(),
          kind: 'text',
          text: 'Чат доступен без Premium',
        },
      },
    );
    assert.equal(sent.status, 201);
  } finally {
    await harness.close();
  }
});

test('trainer exact conversation summary is authorized without paginating the inbox', async () => {
  const harness = await startHarness();

  try {
    const created = await jsonRequest(harness, '/api/v1/chat/conversations', {
      method: 'POST',
      body: {},
    });
    const conversationId = String(asRecord(asRecord(created.body).conversation).id);
    const exact = await jsonRequest(harness, `/api/v1/chat/conversations/${conversationId}`, {
      token: harness.trainerToken,
    });
    assert.equal(exact.status, 200);
    const summary = asRecord(asRecord(exact.body).conversation);
    assert.equal(summary.id, conversationId);
    assert.equal(asRecord(summary.client).display_name, 'Анна');

    const unknownQuery = await jsonRequest(
      harness,
      `/api/v1/chat/conversations/${conversationId}?unexpected=true`,
      { token: harness.trainerToken },
    );
    assert.equal(unknownQuery.status, 400);
    assert.equal(asRecord(asRecord(unknownQuery.body).error).code, 'CHAT_INVALID_REQUEST');

    const clientForbidden = await jsonRequest(
      harness,
      `/api/v1/chat/conversations/${conversationId}`,
    );
    assert.equal(clientForbidden.status, 403);
    assert.equal(asRecord(asRecord(clientForbidden.body).error).code, 'CHAT_NOT_AVAILABLE');

    const unassigned = await jsonRequest(harness, `/api/v1/chat/conversations/${conversationId}`, {
      token: harness.otherTrainerToken,
    });
    assert.equal(unassigned.status, 404);
    assert.equal(asRecord(asRecord(unassigned.body).error).code, 'CHAT_RESOURCE_NOT_FOUND');
  } finally {
    await harness.close();
  }
});

test('trainer inbox combines search and unread filters with canonical activity ordering', async () => {
  const harness = await startHarness();
  const baseTime = new Date('2026-08-23T10:00:00.000Z');

  const addConversation = async (
    displayName: string,
    messageTime: Date,
    markRead: boolean,
  ): Promise<string> => {
    const clientId = randomUUID();
    harness.repository.addActor({
      userId: clientId,
      role: 'client',
      onboardingStatus: 'active',
      displayName,
      avatarUrl: null,
    });
    const created = await harness.repository.createOrGetConversation(clientId, baseTime);
    assert.notEqual(created, null);
    const conversationId = created!.conversation.id;
    const sent = await harness.repository.sendMessage({
      userId: clientId,
      conversationId,
      clientMessageId: randomUUID(),
      requestFingerprint: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      kind: 'text',
      body: `Сообщение: ${displayName}`,
      photoId: null,
      now: messageTime,
    });
    assert.equal(sent.kind, 'created');

    if (markRead) {
      const read = await harness.repository.markRead({
        userId: harness.repository.trainerId,
        conversationId,
        throughSequence: 1,
        now: new Date(messageTime.getTime() + 1),
      });
      assert.equal(read.kind, 'updated');
    }

    return conversationId;
  };

  try {
    const targetId = await addConversation(
      'Искомая Анна',
      new Date(baseTime.getTime() + 2_000),
      false,
    );
    const readMatchId = await addConversation(
      'Искомая Прочитанная',
      new Date(baseTime.getTime() + 3_000),
      true,
    );
    await addConversation('Другая Ольга', new Date(baseTime.getTime() + 4_000), false);

    const combined = await jsonRequest(
      harness,
      `/api/v1/chat/conversations?filter=unread&query=${encodeURIComponent('искомая')}&limit=50`,
      { token: harness.trainerToken },
    );
    assert.equal(combined.status, 200);
    assert.deepEqual(
      (asRecord(combined.body).items as readonly unknown[]).map((item) => asRecord(item).id),
      [targetId],
    );

    const searched = await jsonRequest(
      harness,
      `/api/v1/chat/conversations?filter=all&query=${encodeURIComponent('ИСКОМАЯ')}&limit=50`,
      { token: harness.trainerToken },
    );
    assert.equal(searched.status, 200);
    assert.deepEqual(
      (asRecord(searched.body).items as readonly unknown[]).map((item) => asRecord(item).id),
      [readMatchId, targetId],
    );
  } finally {
    await harness.close();
  }
});

test('conversation, message, read, isolation and idempotency contracts are durable', async () => {
  const harness = await startHarness();
  let eventCount = 0;
  const unsubscribe = harness.eventHub.subscribe(() => {
    eventCount += 1;
  });

  try {
    const created = await jsonRequest(harness, '/api/v1/chat/conversations', {
      method: 'POST',
      body: {},
    });
    assert.equal(created.status, 201);
    const conversation = asRecord(asRecord(created.body).conversation);
    const conversationId = String(conversation.id);
    assert.equal(eventCount, 1);

    const again = await jsonRequest(harness, '/api/v1/chat/conversations', {
      method: 'POST',
      body: {},
    });
    assert.equal(again.status, 200);
    assert.equal(asRecord(asRecord(again.body).conversation).id, conversationId);
    assert.equal(eventCount, 1);

    const clientMessageId = randomUUID();
    const first = await jsonRequest(
      harness,
      `/api/v1/chat/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: {
          client_message_id: clientMessageId,
          kind: 'text',
          text: '\u0085\uFEFFCafe\u0301\r\nтест\uFEFF\u0085',
        },
      },
    );
    assert.equal(first.status, 201);
    const firstBody = asRecord(first.body);
    assert.equal(asRecord(firstBody.message).text, '\uFEFFCafé\nтест\uFEFF');
    assert.equal(firstBody.replayed, false);
    assert.equal(eventCount, 2);

    const replay = await jsonRequest(
      harness,
      `/api/v1/chat/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: {
          client_message_id: clientMessageId,
          kind: 'text',
          text: '\uFEFFCafé\nтест\uFEFF',
        },
      },
    );
    assert.equal(replay.status, 200);
    assert.equal(asRecord(replay.body).replayed, true);
    assert.equal(eventCount, 2, 'idempotent replay must not rebroadcast');

    const conflict = await jsonRequest(
      harness,
      `/api/v1/chat/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: { client_message_id: clientMessageId, kind: 'text', text: 'Другое' },
      },
    );
    assert.equal(conflict.status, 409);
    assert.equal(asRecord(asRecord(conflict.body).error).code, 'CHAT_IDEMPOTENCY_CONFLICT');

    const forbiddenControl = await jsonRequest(
      harness,
      `/api/v1/chat/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: {
          client_message_id: randomUUID(),
          kind: 'text',
          text: 'до\u000bпосле',
        },
      },
    );
    assert.equal(forbiddenControl.status, 422);
    assert.equal(asRecord(asRecord(forbiddenControl.body).error).code, 'CHAT_MESSAGE_INVALID');

    const trainerPage = await jsonRequest(
      harness,
      `/api/v1/chat/conversations/${conversationId}/messages`,
      { token: harness.trainerToken },
    );
    assert.equal(trainerPage.status, 200);
    const page = asRecord(trainerPage.body);
    assert.equal(asRecord(page.conversation_state).unread_count, 1);

    const read = await jsonRequest(harness, `/api/v1/chat/conversations/${conversationId}/read`, {
      method: 'PUT',
      token: harness.trainerToken,
      body: { through_sequence: 1 },
    });
    assert.equal(read.status, 200);
    assert.equal(asRecord(asRecord(read.body).conversation_state).own_last_read_sequence, 1);

    const outsiderId = randomUUID();
    const outsiderSession = randomUUID();
    harness.repository.addActor({
      userId: outsiderId,
      role: 'client',
      onboardingStatus: 'active',
      displayName: 'Другой клиент',
      avatarUrl: null,
    });
    harness.repository.addSession(outsiderId, outsiderSession);
    const outsiderTokens = new HmacJwtAccessTokenService(
      'test-only-chat-access-secret-with-more-than-32-characters',
      'kinetra-chat-test',
      'kinetra-chat-pwa-test',
      900,
    );
    const outsiderToken = (await outsiderTokens.issue(outsiderId, outsiderSession, new Date()))
      .token;
    const foreign = await jsonRequest(
      harness,
      `/api/v1/chat/conversations/${conversationId}/messages`,
      { token: outsiderToken },
    );
    assert.equal(foreign.status, 404);

    console.log('KINETRA_T12_BACKEND_E2E=PASS');
    console.log('KINETRA_T12_MESSAGE_DELIVERY=PASS');
  } finally {
    unsubscribe();
    await harness.close();
  }
});

test('photo drafts are uploader-private until a canonical message attaches them', async () => {
  const harness = await startHarness();

  try {
    const created = await jsonRequest(harness, '/api/v1/chat/conversations', {
      method: 'POST',
      body: {},
    });
    const conversationId = String(asRecord(asRecord(created.body).conversation).id);
    const form = new FormData();
    form.append(
      'photo',
      new Blob([Buffer.from('valid-test-photo')], { type: 'image/png' }),
      'x.png',
    );
    const upload = await fetch(
      `${harness.baseUrl}/api/v1/chat/conversations/${conversationId}/photos`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${harness.clientToken}`,
          'Idempotency-Key': randomUUID(),
        },
        body: form,
      },
    );
    assert.equal(upload.status, 201);
    const uploadBody = (await upload.json()) as unknown;
    const photoId = String(asRecord(asRecord(uploadBody).photo).id);

    const trainerDraftAccess = await jsonRequest(harness, `/api/v1/chat/photos/${photoId}/access`, {
      token: harness.trainerToken,
    });
    assert.equal(trainerDraftAccess.status, 404);

    const attached = await jsonRequest(
      harness,
      `/api/v1/chat/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: {
          client_message_id: randomUUID(),
          kind: 'photo',
          text: 'Техника',
          photo_id: photoId,
        },
      },
    );
    assert.equal(attached.status, 201);
    const trainerAttachedAccess = await jsonRequest(
      harness,
      `/api/v1/chat/photos/${photoId}/access`,
      { token: harness.trainerToken },
    );
    assert.equal(trainerAttachedAccess.status, 200);
    assert.equal(
      String(asRecord(trainerAttachedAccess.body).url).includes('private.invalid'),
      true,
    );
  } finally {
    await harness.close();
  }
});

test('multipart stream bytes are charged once for valid and malformed photo requests', async () => {
  const byteMaximum = 100 * 1024 * 1024;
  const validRateLimiter = new InMemoryChatRateLimiter();
  const validHarness = await startHarness(true, validRateLimiter);

  try {
    const created = await jsonRequest(validHarness, '/api/v1/chat/conversations', {
      method: 'POST',
      body: {},
    });
    const conversationId = String(asRecord(asRecord(created.body).conversation).id);
    const boundary = 'kinetra-byte-accounting-valid';
    const body = rawPhotoMultipart(boundary, Buffer.from('valid-test-photo'), true);
    validRateLimiter.consume({
      scope: 'photo_bytes_hour',
      key: `principal:${validHarness.repository.clientId}`,
      maximum: byteMaximum,
      windowMs: 60 * 60 * 1000,
      cost: byteMaximum - body.length,
    });

    const upload = await postRawPhoto(validHarness, conversationId, boundary, body);
    assert.equal(
      upload.status,
      201,
      'a valid request at the exact byte ceiling must not be charged again by the service',
    );
  } finally {
    await validHarness.close();
  }

  const malformedRateLimiter = new InMemoryChatRateLimiter();
  const malformedHarness = await startHarness(true, malformedRateLimiter);

  try {
    const created = await jsonRequest(malformedHarness, '/api/v1/chat/conversations', {
      method: 'POST',
      body: {},
    });
    const conversationId = String(asRecord(asRecord(created.body).conversation).id);
    const boundary = 'kinetra-byte-accounting-incomplete';
    const body = rawPhotoMultipart(boundary, Buffer.alloc(4096, 0x61), false);
    malformedRateLimiter.consume({
      scope: 'photo_bytes_hour',
      key: `principal:${malformedHarness.repository.clientId}`,
      maximum: byteMaximum,
      windowMs: 60 * 60 * 1000,
      cost: byteMaximum - body.length,
    });

    const malformed = await postRawPhoto(malformedHarness, conversationId, boundary, body);
    assert.equal(malformed.status, 400);
    assert.equal(asRecord(asRecord(malformed.body).error).code, 'CHAT_INVALID_REQUEST');

    const exhausted = await postRawPhoto(malformedHarness, conversationId, boundary, body);
    assert.equal(exhausted.status, 429);
    assert.equal(asRecord(asRecord(exhausted.body).error).code, 'CHAT_RATE_LIMITED');
  } finally {
    await malformedHarness.close();
  }
});
