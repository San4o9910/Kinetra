import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';

import express from 'express';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { Server as SocketServer } from 'socket.io';

import { HttpError } from '../src/auth/errors.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import { resolveChatClientIp } from '../src/chat/client-ip.js';
import { ChatEventHub } from '../src/chat/event-hub.js';
import type { ChatRateLimitInput, ChatRateLimiter } from '../src/chat/rate-limit.js';
import { attachChatRealtime } from '../src/chat/realtime.js';
import { createChatRouter } from '../src/chat/router.js';
import { ChatService } from '../src/chat/service.js';
import {
  FakeChatImageProcessor,
  FakeChatMediaStore,
  FixedChatClock,
} from './support/fake-chat-media.js';
import { InMemoryChatRepository } from './support/in-memory-chat.repository.js';

class RecordingRateLimiter implements ChatRateLimiter {
  public readonly calls: ChatRateLimitInput[] = [];

  public consume(input: ChatRateLimitInput): void {
    this.calls.push(input);
  }
}

class OneHandshakePerIpLimiter extends RecordingRateLimiter {
  private readonly handshakes = new Map<string, number>();

  public override consume(input: ChatRateLimitInput): void {
    super.consume(input);

    if (input.scope !== 'websocket_handshake') {
      return;
    }

    const count = (this.handshakes.get(input.key) ?? 0) + 1;
    this.handshakes.set(input.key, count);

    if (count > 1) {
      throw new HttpError(429, 'CHAT_RATE_LIMITED', 'Test handshake bucket was reused.');
    }
  }
}

const connect = async (socket: Socket): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Socket connect timed out.')), 3_000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.connect();
  });
};

const connectErrorCode = async (socket: Socket): Promise<string | undefined> => {
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Expected socket connect_error.')), 3_000);
      socket.once('connect_error', (error) => {
        clearTimeout(timeout);
        resolve((error as Error & { data?: { readonly code?: string } }).data?.code);
      });
      socket.connect();
    });
  } finally {
    socket.disconnect();
  }
};

const createService = (
  repository: InMemoryChatRepository,
  rateLimiter: ChatRateLimiter,
  eventHub = new ChatEventHub(),
): ChatService =>
  new ChatService({
    repository,
    eventPublisher: eventHub,
    rateLimiter,
    imageProcessor: new FakeChatImageProcessor(),
    mediaStore: new FakeChatMediaStore(),
    clock: new FixedChatClock(new Date('2026-08-23T10:00:00.000Z')),
    enabled: true,
    photoUploadsEnabled: true,
    mediaUrlTtlSeconds: 300,
    cursorSecret: 'test-only-client-ip-cursor-secret-with-32-bytes',
  });

const createTokens = (): HmacJwtAccessTokenService =>
  new HmacJwtAccessTokenService(
    'test-only-client-ip-access-secret-with-more-than-32-characters',
    'kinetra-client-ip-test',
    'kinetra-client-ip-pwa-test',
    900,
  );

test('exact-hop resolver ignores spoofing and fails closed on malformed or short chains', () => {
  const remote = '::ffff:127.0.0.1';
  assert.equal(
    resolveChatClientIp({ remoteAddress: remote, xForwardedFor: '198.51.100.77' }, 0),
    '127.0.0.1',
  );
  assert.equal(
    resolveChatClientIp({ remoteAddress: remote, xForwardedFor: '198.51.100.10' }, 1),
    '198.51.100.10',
  );
  assert.equal(
    resolveChatClientIp({ remoteAddress: remote, xForwardedFor: '198.51.100.10, 10.0.0.8' }, 2),
    '198.51.100.10',
  );
  assert.equal(
    resolveChatClientIp({ remoteAddress: remote, xForwardedFor: 'malformed, 198.51.100.10' }, 1),
    '127.0.0.1',
  );
  assert.equal(
    resolveChatClientIp({ remoteAddress: remote, xForwardedFor: '198.51.100.10' }, 2),
    '127.0.0.1',
  );
  assert.equal(
    resolveChatClientIp({ remoteAddress: remote, xForwardedFor: ['198.51.100.10'] }, 1),
    '127.0.0.1',
  );
});

test('HTTP chat contexts use the same exact-hop resolver for IP rate-limit keys', async () => {
  const repository = new InMemoryChatRepository();
  const sessionId = randomUUID();
  repository.addSession(repository.clientId, sessionId);
  const limiter = new RecordingRateLimiter();
  const service = createService(repository, limiter);
  const tokens = createTokens();
  const conversation = await repository.createOrGetConversation(
    repository.clientId,
    new Date('2026-08-23T10:00:00.000Z'),
  );
  assert.notEqual(conversation, null);
  const app = express();
  app.use(express.json());
  app.use(
    '/direct',
    createChatRouter({
      service,
      authMiddleware: createAuthMiddleware(tokens),
      trustedProxyHops: 0,
    }),
  );
  app.use(
    '/proxied',
    createChatRouter({
      service,
      authMiddleware: createAuthMiddleware(tokens),
      trustedProxyHops: 1,
    }),
  );
  app.use(
    '/two-proxies',
    createChatRouter({
      service,
      authMiddleware: createAuthMiddleware(tokens),
      trustedProxyHops: 2,
    }),
  );
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('HTTP client-IP test server did not expose a TCP address.');
  }

  const token = (await tokens.issue(repository.clientId, sessionId, new Date())).token;
  const send = async (prefix: string, forwardedFor: string): Promise<number> => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${prefix}/conversations/${conversation!.conversation.id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Forwarded-For': forwardedFor,
        },
        body: JSON.stringify({
          client_message_id: randomUUID(),
          kind: 'text',
          text: 'IP resolver test',
        }),
      },
    );
    await response.body?.cancel();
    return response.status;
  };

  try {
    assert.equal(await send('/direct', '198.51.100.90'), 201);
    assert.equal(
      limiter.calls.some((call) => call.scope === 'message' && call.key === 'ip:127.0.0.1'),
      true,
    );
    limiter.calls.length = 0;
    assert.equal(await send('/proxied', '198.51.100.91'), 201);
    assert.equal(
      limiter.calls.some((call) => call.scope === 'message' && call.key === 'ip:198.51.100.91'),
      true,
    );
    limiter.calls.length = 0;
    assert.equal(await send('/proxied', 'malformed, 198.51.100.92'), 201);
    assert.equal(
      limiter.calls.some((call) => call.scope === 'message' && call.key === 'ip:127.0.0.1'),
      true,
    );
    limiter.calls.length = 0;
    assert.equal(await send('/two-proxies', '198.51.100.93'), 201);
    assert.equal(
      limiter.calls.some((call) => call.scope === 'message' && call.key === 'ip:127.0.0.1'),
      true,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test('trusted proxy clients receive distinct real Socket.IO handshake buckets', async () => {
  const repository = new InMemoryChatRepository();
  const sessionId = randomUUID();
  repository.addSession(repository.clientId, sessionId);
  const limiter = new OneHandshakePerIpLimiter();
  const eventHub = new ChatEventHub();
  const service = createService(repository, limiter, eventHub);
  const tokens = createTokens();
  const token = (await tokens.issue(repository.clientId, sessionId, new Date())).token;
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, {
    transports: ['websocket'],
    maxHttpBufferSize: 32 * 1024,
  });
  const detach = attachChatRealtime(socketServer, {
    accessTokenVerifier: tokens,
    service,
    eventHub,
    rateLimiter: limiter,
    allowedOrigins: ['http://allowed.example'],
    trustedProxyHops: 2,
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Socket client-IP test server did not expose a TCP address.');
  }

  const url = `http://127.0.0.1:${address.port}/chat`;
  const socketOptions = (forwardedFor: string): Partial<ManagerOptions & SocketOptions> => ({
    autoConnect: false,
    transports: ['websocket'],
    auth: { accessToken: token },
    extraHeaders: {
      Origin: 'http://allowed.example',
      'X-Forwarded-For': forwardedFor,
    },
    reconnection: false,
  });
  const first = io(url, socketOptions('198.51.100.101, 10.0.0.8'));
  const second = io(url, socketOptions('198.51.100.102, 10.0.0.8'));
  const malformed = io(url, socketOptions('malformed, 198.51.100.103, 10.0.0.8'));
  const short = io(url, socketOptions('198.51.100.104'));

  try {
    await Promise.all([connect(first), connect(second)]);
    await connect(malformed);
    assert.equal(await connectErrorCode(short), 'CHAT_RATE_LIMITED');
    const handshakeKeys = limiter.calls
      .filter((call) => call.scope === 'websocket_handshake')
      .map((call) => call.key)
      .sort();
    assert.deepEqual(handshakeKeys, [
      'ip:127.0.0.1',
      'ip:127.0.0.1',
      'ip:198.51.100.101',
      'ip:198.51.100.102',
    ]);
  } finally {
    first.disconnect();
    second.disconnect();
    malformed.disconnect();
    short.disconnect();
    detach();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));

    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  }
});
