import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { test } from 'node:test';

import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { Server as SocketServer } from 'socket.io';

import { HttpError } from '../src/auth/errors.js';
import type { AccessTokenClaims } from '../src/auth/tokens.js';
import { ChatEventHub } from '../src/chat/event-hub.js';
import {
  InMemoryChatRateLimiter,
  NoopChatRateLimiter,
  type ChatRateLimitInput,
  type ChatRateLimiter,
} from '../src/chat/rate-limit.js';
import { attachChatRealtime } from '../src/chat/realtime.js';
import type {
  ChatActor,
  ChatConversationSnapshot,
  ListMessagesInput,
  MessagePage,
} from '../src/chat/repository.js';
import {
  ChatService,
  ChatSocketSyncAdmission,
  type ChatRequestContext,
} from '../src/chat/service.js';
import {
  FakeChatImageProcessor,
  FakeChatMediaStore,
  FixedChatClock,
} from './support/fake-chat-media.js';
import { InMemoryChatRepository } from './support/in-memory-chat.repository.js';

interface TestIdentity {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: 'client' | 'trainer';
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const waitFor = async (
  predicate: () => boolean,
  description: string,
  timeoutMs = 3_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const onceEvent = async <T>(socket: Socket, eventName: string, timeoutMs = 3_000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${eventName}.`)),
      timeoutMs,
    );
    socket.once(eventName, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });

const expectNoEvent = async (socket: Socket, eventName: string, timeoutMs = 200): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onEvent = () => {
      clearTimeout(timeout);
      reject(new Error(`Unexpected ${eventName} event.`));
    };
    const timeout = setTimeout(() => {
      socket.off(eventName, onEvent);
      resolve();
    }, timeoutMs);
    socket.once(eventName, onEvent);
  });

const emitSync = (
  socket: Socket,
  conversationId: string,
  acknowledge?: (response: { readonly delta_required: boolean }) => void,
): void => {
  socket.emit(
    'chat:sync',
    { conversation_id: conversationId, last_sequence: 0 },
    acknowledge ?? (() => undefined),
  );
};

const syncAcknowledgement = async (
  socket: Socket,
  conversationId: string,
): Promise<{ readonly delta_required: boolean }> =>
  new Promise<{ readonly delta_required: boolean }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sync acknowledgement timed out.')), 3_000);
    emitSync(socket, conversationId, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });

const conversationFixture = (input?: {
  readonly id?: string;
  readonly clientUserId?: string;
  readonly trainerUserId?: string;
}): ChatConversationSnapshot => {
  const now = new Date('2026-08-24T10:00:00.000Z');
  return {
    id: input?.id ?? randomUUID(),
    client: {
      userId: input?.clientUserId ?? randomUUID(),
      displayName: 'Клиент',
      secondaryLabel: 'к***@example.com',
      avatarUrl: null,
    },
    trainer: {
      userId: input?.trainerUserId ?? randomUUID(),
      displayName: 'Тренер',
      secondaryLabel: 'Тренер',
      avatarUrl: null,
    },
    lastMessage: null,
    lastMessageSequence: 0,
    clientLastReadSequence: 0,
    trainerLastReadSequence: 0,
    clientUnreadCount: 0,
    trainerUnreadCount: 0,
    createdAt: now,
    activityAt: now,
  };
};

class RealtimeServiceDouble {
  public readonly identities = new Map<string, TestIdentity>();
  public readonly admissionContexts: ChatRequestContext[] = [];
  public readonly authorizationCalls: {
    readonly admission: ChatSocketSyncAdmission;
    readonly conversationId: string;
    readonly lastSequence: number;
  }[] = [];
  public conversation: ChatConversationSnapshot | null = null;
  public admitHook: (context: ChatRequestContext) => void = () => undefined;
  public authorizeHook: (
    admission: ChatSocketSyncAdmission,
    conversationId: string,
    lastSequence: number,
  ) => Promise<void> = async () => undefined;
  public getConversationHook: (conversationId: string) => Promise<ChatConversationSnapshot | null> =
    async () => this.conversation;
  public recipientHook: (
    conversation: ChatConversationSnapshot,
    userId: string,
    sessionId: string,
    role: 'client' | 'trainer',
  ) => Promise<'active' | 'session_inactive' | 'account_changed' | 'not_participant'> = async () =>
    'active';

  public addIdentity(identity: TestIdentity): void {
    this.identities.set(`${identity.userId}:${identity.sessionId}`, identity);
  }

  public async getSocketActor(userId: string, sessionId: string): Promise<ChatActor | null> {
    const identity = this.identities.get(`${userId}:${sessionId}`);
    return identity === undefined
      ? null
      : {
          userId,
          role: identity.role,
          onboardingStatus: identity.role === 'client' ? 'active' : 'survey_pending',
          displayName: identity.role === 'client' ? 'Клиент' : 'Тренер',
          avatarUrl: null,
        };
  }

  public async validateSocketIdentity(
    userId: string,
    sessionId: string,
    expectedRole: 'client' | 'trainer',
  ): Promise<'active' | 'session_inactive' | 'account_changed'> {
    const identity = this.identities.get(`${userId}:${sessionId}`);

    if (identity === undefined) {
      return 'session_inactive';
    }

    return identity.role === expectedRole ? 'active' : 'account_changed';
  }

  public admitSocketSync(context: ChatRequestContext): ChatSocketSyncAdmission {
    this.admissionContexts.push(context);
    this.admitHook(context);
    return new ChatSocketSyncAdmission(this as unknown as ChatService, context);
  }

  public async authorizeSocketSync(
    admission: ChatSocketSyncAdmission,
    conversationId: string,
    lastSequence: number,
  ): Promise<void> {
    this.authorizationCalls.push({ admission, conversationId, lastSequence });
    return this.authorizeHook(admission, conversationId, lastSequence);
  }

  public async getRealtimeConversation(
    conversationId: string,
  ): Promise<ChatConversationSnapshot | null> {
    return this.getConversationHook(conversationId);
  }

  public async validateRealtimeRecipient(
    conversation: ChatConversationSnapshot,
    userId: string,
    sessionId: string,
    role: 'client' | 'trainer',
  ): Promise<'active' | 'session_inactive' | 'account_changed' | 'not_participant'> {
    return this.recipientHook(conversation, userId, sessionId, role);
  }
}

interface RealtimeHarness {
  readonly eventHub: ChatEventHub;
  readonly connectIdentity: (identity: TestIdentity, forwardedFor?: string) => Promise<Socket>;
  readonly close: () => Promise<void>;
}

const startRealtimeHarness = async (
  service: ChatService,
  rateLimiter: ChatRateLimiter = new NoopChatRateLimiter(),
  trustedProxyHops = 0,
): Promise<RealtimeHarness> => {
  const claimsByToken = new Map<string, AccessTokenClaims>();
  const clients = new Set<Socket>();
  const eventHub = new ChatEventHub();
  const httpServer: HttpServer = createServer();
  const socketServer = new SocketServer(httpServer, {
    transports: ['websocket'],
    maxHttpBufferSize: 32 * 1024,
  });
  const detach = attachChatRealtime(socketServer, {
    accessTokenVerifier: {
      verify: async (token) => {
        const claims = claimsByToken.get(token);

        if (claims === undefined) {
          throw new Error('Unknown test access token.');
        }

        return claims;
      },
    },
    service,
    eventHub,
    rateLimiter,
    allowedOrigins: ['http://allowed.example'],
    trustedProxyHops,
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Realtime test server did not expose a TCP address.');
  }

  const url = `http://127.0.0.1:${address.port}/chat`;

  return {
    eventHub,
    connectIdentity: async (identity, forwardedFor) => {
      const token = `test-${randomUUID()}`;
      const nowSeconds = Math.floor(Date.now() / 1_000);
      claimsByToken.set(token, {
        sub: identity.userId,
        sid: identity.sessionId,
        type: 'access',
        iss: 'kinetra-realtime-admission-test',
        aud: 'kinetra-realtime-admission-test',
        iat: nowSeconds,
        exp: nowSeconds + 600,
        jti: randomUUID(),
      });
      const socketOptions: Partial<ManagerOptions & SocketOptions> = {
        autoConnect: false,
        transports: ['websocket'],
        auth: { accessToken: token },
        extraHeaders: {
          Origin: 'http://allowed.example',
          ...(forwardedFor === undefined ? {} : { 'X-Forwarded-For': forwardedFor }),
        },
        reconnection: false,
      };
      const socket = io(url, socketOptions);
      clients.add(socket);
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
      return socket;
    },
    close: async () => {
      for (const socket of clients) {
        socket.disconnect();
      }

      detach();
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));

      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) =>
          httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
        );
      }
    },
  };
};

test('realtime fan-out releases its conversation snapshot before recipient validation', async () => {
  const service = new RealtimeServiceDouble();
  const conversation = conversationFixture();
  service.conversation = conversation;
  const clientIdentity: TestIdentity = {
    userId: conversation.client.userId,
    sessionId: randomUUID(),
    role: 'client',
  };
  const trainerIdentity: TestIdentity = {
    userId: conversation.trainer.userId,
    sessionId: randomUUID(),
    role: 'trainer',
  };
  service.addIdentity(clientIdentity);
  service.addIdentity(trainerIdentity);
  const snapshotStarted = deferred<void>();
  const releaseSnapshot = deferred<void>();
  const validationStarted = deferred<void>();
  const releaseValidation = deferred<void>();
  let snapshotLeaseHeld = false;
  let validationCount = 0;
  service.getConversationHook = async () => {
    snapshotLeaseHeld = true;
    snapshotStarted.resolve();
    await releaseSnapshot.promise;
    snapshotLeaseHeld = false;
    return conversation;
  };
  service.recipientHook = async () => {
    assert.equal(snapshotLeaseHeld, false, 'recipient validation must run after snapshot release');
    validationCount += 1;

    if (validationCount === 1) {
      validationStarted.resolve();
    }

    await releaseValidation.promise;
    return 'active';
  };
  const harness = await startRealtimeHarness(service as unknown as ChatService);
  const clientSocket = await harness.connectIdentity(clientIdentity);
  const trainerSocket = await harness.connectIdentity(trainerIdentity);

  try {
    const clientUpdate = onceEvent(clientSocket, 'chat:conversation:updated');
    const trainerUpdate = onceEvent(trainerSocket, 'chat:conversation:updated');
    const publication = harness.eventHub.publish({ kind: 'conversation_updated', conversation });
    await snapshotStarted.promise;
    assert.equal(validationCount, 0, 'no pool-backed recipient lookup starts under the snapshot');
    releaseSnapshot.resolve();
    await validationStarted.promise;

    const unrelatedWork = Promise.resolve().then(() => {
      assert.equal(snapshotLeaseHeld, false, 'unrelated work sees the released snapshot lease');
      return 'available';
    });
    assert.equal(await unrelatedWork, 'available');
    releaseValidation.resolve();
    await publication;
    await Promise.all([clientUpdate, trainerUpdate]);
    assert.equal(validationCount, 2);
  } finally {
    await harness.close();
  }
});

test('reassignment and session revocation during fan-out suppress stale recipients', async () => {
  const service = new RealtimeServiceDouble();
  const conversation = conversationFixture();
  service.conversation = conversation;
  const clientIdentity: TestIdentity = {
    userId: conversation.client.userId,
    sessionId: randomUUID(),
    role: 'client',
  };
  const oldTrainerIdentity: TestIdentity = {
    userId: conversation.trainer.userId,
    sessionId: randomUUID(),
    role: 'trainer',
  };
  service.addIdentity(clientIdentity);
  service.addIdentity(oldTrainerIdentity);
  const validationsReady = deferred<void>();
  const releaseValidations = deferred<void>();
  let validationCount = 0;
  let clientRevoked = false;
  let trainerReassigned = false;
  service.recipientHook = async (_snapshot, _userId, _sessionId, role) => {
    validationCount += 1;

    if (validationCount === 2) {
      validationsReady.resolve();
    }

    await releaseValidations.promise;

    if (role === 'client' && clientRevoked) {
      return 'session_inactive';
    }

    return role === 'trainer' && trainerReassigned ? 'not_participant' : 'active';
  };
  const harness = await startRealtimeHarness(service as unknown as ChatService);
  const clientSocket = await harness.connectIdentity(clientIdentity);
  const oldTrainerSocket = await harness.connectIdentity(oldTrainerIdentity);

  try {
    const clientInvalidated = onceEvent<{ readonly reason: string }>(
      clientSocket,
      'chat:session:invalidated',
    );
    const noClientUpdate = expectNoEvent(clientSocket, 'chat:conversation:updated');
    const noOldTrainerUpdate = expectNoEvent(oldTrainerSocket, 'chat:conversation:updated');
    const publication = harness.eventHub.publish({ kind: 'conversation_updated', conversation });
    await validationsReady.promise;
    clientRevoked = true;
    trainerReassigned = true;
    releaseValidations.resolve();
    await publication;
    assert.deepEqual(await clientInvalidated, { reason: 'session_inactive' });
    await Promise.all([noClientUpdate, noOldTrainerUpdate]);
    assert.equal(
      oldTrainerSocket.connected,
      true,
      'stale assignment is skipped without relabeling',
    );
  } finally {
    await harness.close();
  }
});

test('one recipient validation failure cannot block delivery to another active socket', async () => {
  const service = new RealtimeServiceDouble();
  const conversation = conversationFixture();
  service.conversation = conversation;
  const clientIdentity: TestIdentity = {
    userId: conversation.client.userId,
    sessionId: randomUUID(),
    role: 'client',
  };
  const goodTrainerIdentity: TestIdentity = {
    userId: conversation.trainer.userId,
    sessionId: randomUUID(),
    role: 'trainer',
  };
  const failingTrainerIdentity: TestIdentity = {
    userId: conversation.trainer.userId,
    sessionId: randomUUID(),
    role: 'trainer',
  };
  service.addIdentity(clientIdentity);
  service.addIdentity(goodTrainerIdentity);
  service.addIdentity(failingTrainerIdentity);
  service.recipientHook = async (_conversation, _userId, sessionId) => {
    if (sessionId === failingTrainerIdentity.sessionId) {
      throw new Error('simulated recipient lookup failure');
    }

    return 'active';
  };
  const harness = await startRealtimeHarness(service as unknown as ChatService);
  const clientSocket = await harness.connectIdentity(clientIdentity);
  const goodTrainerSocket = await harness.connectIdentity(goodTrainerIdentity);
  const failingTrainerSocket = await harness.connectIdentity(failingTrainerIdentity);

  try {
    const clientUpdate = onceEvent(clientSocket, 'chat:conversation:updated');
    const goodTrainerUpdate = onceEvent(goodTrainerSocket, 'chat:conversation:updated');
    const failingTrainerInvalidated = onceEvent<{ readonly reason: string }>(
      failingTrainerSocket,
      'chat:session:invalidated',
    );
    await harness.eventHub.publish({ kind: 'conversation_updated', conversation });
    await Promise.all([clientUpdate, goodTrainerUpdate]);
    assert.deepEqual(await failingTrainerInvalidated, { reason: 'session_inactive' });
  } finally {
    await harness.close();
  }
});

test('chat:sync enforces one conversation attempt and the four-attempt socket cap', async () => {
  const service = new RealtimeServiceDouble();
  const identity: TestIdentity = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    role: 'trainer',
  };
  service.addIdentity(identity);
  const attempts = new Map<string, Deferred<void>[]>();
  service.authorizeHook = async (_admission, conversationId) => {
    const hold = deferred<void>();
    const entries = attempts.get(conversationId) ?? [];
    entries.push(hold);
    attempts.set(conversationId, entries);
    return hold.promise;
  };
  const harness = await startRealtimeHarness(service as unknown as ChatService);
  const socket = await harness.connectIdentity(identity);

  try {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    emitSync(socket, ids[0]!);
    emitSync(socket, ids[0]!.toUpperCase());
    for (const id of ids.slice(1)) {
      emitSync(socket, id);
    }

    await waitFor(() => service.authorizationCalls.length === 4, 'four accepted socket syncs');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(service.authorizationCalls.length, 4);
    assert.equal(
      service.authorizationCalls.filter((call) => call.conversationId === ids[0]).length,
      1,
      'the duplicate conversation is rejected while its first sync is in flight',
    );

    attempts.get(ids[0]!)?.[0]?.resolve();
    attempts
      .get(ids[1]!)?.[0]
      ?.reject(new HttpError(404, 'CHAT_RESOURCE_NOT_FOUND', 'Conversation not found.'));
    attempts.get(ids[2]!)?.[0]?.resolve();
    attempts.get(ids[3]!)?.[0]?.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    emitSync(socket, ids[0]!);
    emitSync(socket, ids[4]!);
    await waitFor(
      () => service.authorizationCalls.length === 6,
      'released success and error sync guards',
    );
    assert.equal(
      socket.connected,
      true,
      'ordinary authorization errors do not invalidate a socket',
    );

    for (const holds of attempts.values()) {
      for (const hold of holds) {
        hold.resolve();
      }
    }
  } finally {
    await harness.close();
  }
});

test('chat:sync keeps disconnected storage work inside the eight-attempt principal cap', async () => {
  const service = new RealtimeServiceDouble();
  const identity: TestIdentity = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    role: 'trainer',
  };
  service.addIdentity(identity);
  const holds: Deferred<void>[] = [];
  service.authorizeHook = async () => {
    const hold = deferred<void>();
    holds.push(hold);
    return hold.promise;
  };
  const harness = await startRealtimeHarness(service as unknown as ChatService);
  const firstSocket = await harness.connectIdentity(identity);
  const secondSocket = await harness.connectIdentity(identity);
  const thirdSocket = await harness.connectIdentity(identity);
  const emitFour = (socket: Socket): void => {
    for (let index = 0; index < 4; index += 1) {
      emitSync(socket, randomUUID());
    }
  };

  try {
    emitFour(firstSocket);
    await waitFor(() => service.authorizationCalls.length === 4, 'first socket reservations');
    emitFour(secondSocket);
    await waitFor(() => service.authorizationCalls.length === 8, 'principal reservations');
    emitFour(thirdSocket);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(service.authorizationCalls.length, 8, 'changing UUIDs cannot bypass the cap');

    firstSocket.disconnect();
    await waitFor(() => !firstSocket.connected, 'first socket disconnect');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    emitFour(thirdSocket);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(
      service.authorizationCalls.length,
      8,
      'disconnect cannot uncharge storage work that is still running',
    );

    for (const hold of holds.slice(0, 4)) {
      hold.resolve();
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    emitFour(thirdSocket);
    await waitFor(
      () => service.authorizationCalls.length === 12,
      'principal reservations released after disconnected work settles',
    );

    for (const hold of holds) {
      hold.resolve();
    }
  } finally {
    await harness.close();
  }
});

test('chat:sync invalidates sockets on 401 and 403 authorization failures', async () => {
  const service = new RealtimeServiceDouble();
  const inactiveIdentity: TestIdentity = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    role: 'client',
  };
  const changedIdentity: TestIdentity = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    role: 'client',
  };
  service.addIdentity(inactiveIdentity);
  service.addIdentity(changedIdentity);
  const inactiveConversationId = randomUUID();
  const changedConversationId = randomUUID();
  service.authorizeHook = async (_admission, conversationId) => {
    if (conversationId === inactiveConversationId) {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'Session inactive.');
    }

    throw new HttpError(403, 'CHAT_NOT_AVAILABLE', 'Account changed.');
  };
  const harness = await startRealtimeHarness(service as unknown as ChatService);
  const inactiveSocket = await harness.connectIdentity(inactiveIdentity);
  const changedSocket = await harness.connectIdentity(changedIdentity);

  try {
    const inactiveEvent = onceEvent<{ readonly reason: string }>(
      inactiveSocket,
      'chat:session:invalidated',
    );
    const changedEvent = onceEvent<{ readonly reason: string }>(
      changedSocket,
      'chat:session:invalidated',
    );
    emitSync(inactiveSocket, inactiveConversationId);
    emitSync(changedSocket, changedConversationId);
    assert.deepEqual(await inactiveEvent, { reason: 'session_inactive' });
    assert.deepEqual(await changedEvent, { reason: 'account_changed' });
    await waitFor(
      () => !inactiveSocket.connected && !changedSocket.connected,
      'authorization-failed disconnects',
    );
  } finally {
    await harness.close();
  }
});

class CountingChatRepository extends InMemoryChatRepository {
  public operationCount = 0;

  public resetOperationCount(): void {
    this.operationCount = 0;
  }

  public override async findActor(userId: string): Promise<ChatActor | null> {
    this.operationCount += 1;
    return super.findActor(userId);
  }

  public override async isSessionActive(
    userId: string,
    sessionId: string,
    now: Date,
  ): Promise<boolean> {
    this.operationCount += 1;
    return super.isSessionActive(userId, sessionId, now);
  }

  public override async listMessages(input: ListMessagesInput): Promise<MessagePage | null> {
    this.operationCount += 1;
    return super.listMessages(input);
  }
}

class RecordingInMemoryChatRateLimiter extends InMemoryChatRateLimiter {
  public readonly calls: ChatRateLimitInput[] = [];

  public override consume(input: ChatRateLimitInput): void {
    this.calls.push(input);
    super.consume(input);
  }
}

class SelectiveSyncRateLimiter implements ChatRateLimiter {
  public readonly calls: ChatRateLimitInput[] = [];

  public constructor(private readonly deniedUserId: string) {}

  public consume(input: ChatRateLimitInput): void {
    this.calls.push(input);

    if (input.scope === 'history' && input.key === `principal:${this.deniedUserId}`) {
      throw new HttpError(429, 'CHAT_RATE_LIMITED', 'Too many chat requests.');
    }
  }
}

test('chat:sync principal and IP admission rejects before repository work without disconnecting peers', async () => {
  const repository = new CountingChatRepository();
  const deniedSessionId = randomUUID();
  const validClientId = randomUUID();
  const validSessionId = randomUUID();
  repository.addSession(repository.clientId, deniedSessionId);
  repository.addActor({
    userId: validClientId,
    role: 'client',
    onboardingStatus: 'active',
    displayName: 'Второй клиент',
    avatarUrl: null,
  });
  repository.addSession(validClientId, validSessionId);
  const deniedConversation = await repository.createOrGetConversation(
    repository.clientId,
    new Date('2026-08-24T10:00:00.000Z'),
  );
  const validConversation = await repository.createOrGetConversation(
    validClientId,
    new Date('2026-08-24T10:00:01.000Z'),
  );
  assert.notEqual(deniedConversation, null);
  assert.notEqual(validConversation, null);
  const rateLimiter = new SelectiveSyncRateLimiter(repository.clientId);
  const service = new ChatService({
    repository,
    eventPublisher: new ChatEventHub(),
    rateLimiter,
    imageProcessor: new FakeChatImageProcessor(),
    mediaStore: new FakeChatMediaStore(),
    clock: new FixedChatClock(new Date('2026-08-24T10:00:02.000Z')),
    enabled: true,
    photoUploadsEnabled: true,
    mediaUrlTtlSeconds: 300,
    cursorSecret: 'test-only-chat-cursor-secret-with-at-least-32-bytes',
  });
  const harness = await startRealtimeHarness(service, rateLimiter);
  const deniedSocket = await harness.connectIdentity({
    userId: repository.clientId,
    sessionId: deniedSessionId,
    role: 'client',
  });
  const validSocket = await harness.connectIdentity({
    userId: validClientId,
    sessionId: validSessionId,
    role: 'client',
  });

  try {
    repository.resetOperationCount();
    const callsBeforeDeniedSync = rateLimiter.calls.length;
    emitSync(deniedSocket, deniedConversation!.conversation.id);
    await waitFor(
      () => rateLimiter.calls.length > callsBeforeDeniedSync,
      'denied principal admission',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(repository.operationCount, 0, 'a 429 admission path performs no repository work');
    assert.equal(deniedSocket.connected, true, 'rate rejection is not an auth invalidation');

    repository.resetOperationCount();
    assert.deepEqual(await syncAcknowledgement(validSocket, validConversation!.conversation.id), {
      delta_required: true,
    });
    assert.ok(repository.operationCount >= 3, 'the admitted request reaches authorization storage');
    const historyCalls = rateLimiter.calls.filter((call) => call.scope === 'history');
    assert.ok(
      historyCalls.some((call) => call.key === `principal:${validClientId}`),
      'sync admission is principal scoped',
    );
    assert.ok(
      historyCalls.some((call) => call.key.startsWith('ip:')),
      'sync admission is also IP scoped',
    );
    assert.equal(validSocket.connected, true, 'a denied peer does not disconnect a valid socket');
  } finally {
    await harness.close();
  }
});

test('chat:sync shares the real principal history burst limit across sockets before repository work', async () => {
  const historyLimit = 120;
  const excessAttempts = 7;
  const repository = new CountingChatRepository();
  const sessionId = randomUUID();
  repository.addSession(repository.clientId, sessionId);
  const conversation = await repository.createOrGetConversation(
    repository.clientId,
    new Date('2026-08-24T10:00:00.000Z'),
  );
  assert.notEqual(conversation, null);
  const rateLimiter = new RecordingInMemoryChatRateLimiter();
  const service = new ChatService({
    repository,
    eventPublisher: new ChatEventHub(),
    rateLimiter,
    imageProcessor: new FakeChatImageProcessor(),
    mediaStore: new FakeChatMediaStore(),
    clock: new FixedChatClock(new Date('2026-08-24T10:00:01.000Z')),
    enabled: true,
    photoUploadsEnabled: true,
    mediaUrlTtlSeconds: 300,
    cursorSecret: 'test-only-chat-cursor-secret-with-at-least-32-bytes',
  });
  const harness = await startRealtimeHarness(service, rateLimiter, 1);
  const identity: TestIdentity = {
    userId: repository.clientId,
    sessionId,
    role: 'client',
  };
  const firstIp = '198.51.100.10';
  const secondIp = '198.51.100.11';
  const firstSocket = await harness.connectIdentity(identity, firstIp);
  const secondSocket = await harness.connectIdentity(identity, secondIp);
  const sockets = [firstSocket, secondSocket] as const;
  const principalKey = `principal:${repository.clientId}`;
  const historyCallsFor = (key: string): ChatRateLimitInput[] =>
    rateLimiter.calls.filter((call) => call.scope === 'history' && call.key === key);

  try {
    for (let index = 0; index < historyLimit; index += 1) {
      assert.deepEqual(
        await syncAcknowledgement(sockets[index % sockets.length]!, conversation!.conversation.id),
        { delta_required: true },
      );
    }

    assert.equal(
      historyCallsFor(principalKey).length,
      historyLimit,
      'both sockets consume one shared principal counter',
    );
    assert.equal(historyCallsFor(`ip:${firstIp}`).length, historyLimit / 2);
    assert.equal(historyCallsFor(`ip:${secondIp}`).length, historyLimit / 2);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    repository.resetOperationCount();

    for (let index = 0; index < excessAttempts; index += 1) {
      emitSync(sockets[index % sockets.length]!, randomUUID());
    }

    await waitFor(
      () => historyCallsFor(principalKey).length === historyLimit + excessAttempts,
      'all excess principal limiter attempts',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(
      repository.operationCount,
      0,
      'every limit+N attempt rejected by the real limiter performs zero repository calls',
    );
    assert.equal(
      historyCallsFor(`ip:${firstIp}`).length + historyCallsFor(`ip:${secondIp}`).length,
      historyLimit,
      'principal denial happens before either per-IP counter is consumed',
    );
    assert.equal(firstSocket.connected, true);
    assert.equal(secondSocket.connected, true);
  } finally {
    await harness.close();
  }
});
