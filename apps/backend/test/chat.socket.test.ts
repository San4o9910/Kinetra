import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { Server as SocketServer } from 'socket.io';

import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import { ChatEventHub } from '../src/chat/event-hub.js';
import {
  InMemoryChatRateLimiter,
  type ChatRateLimitInput,
  type ChatRateLimiter,
} from '../src/chat/rate-limit.js';
import { attachChatRealtime } from '../src/chat/realtime.js';
import { ChatService } from '../src/chat/service.js';
import {
  FakeChatImageProcessor,
  FakeChatMediaStore,
  FixedChatClock,
} from './support/fake-chat-media.js';
import { InMemoryChatRepository } from './support/in-memory-chat.repository.js';

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

const expectConnectError = async (socket: Socket): Promise<string | undefined> => {
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Expected connect_error.')), 3_000);
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

const onceEvent = async <T>(socket: Socket, event: string, timeoutMs = 3_000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}.`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });

const expectNoEvent = async (socket: Socket, event: string, timeoutMs = 150): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onEvent = () => {
      clearTimeout(timeout);
      reject(new Error(`Unexpected ${event} event.`));
    };
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, timeoutMs);
    socket.once(event, onEvent);
  });

const syncSocket = async (
  socket: Socket,
  conversationId: string,
  lastSequence: number,
): Promise<{ readonly delta_required: boolean }> =>
  new Promise<{ readonly delta_required: boolean }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sync acknowledgement timed out.')), 3_000);
    socket.emit(
      'chat:sync',
      { conversation_id: conversationId, last_sequence: lastSequence },
      (response: { readonly delta_required: boolean }) => {
        clearTimeout(timeout);
        resolve(response);
      },
    );
  });

const expectNoSyncAcknowledgement = async (
  socket: Socket,
  conversationId: string,
  lastSequence: number,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, 150);
    socket.emit(
      'chat:sync',
      { conversation_id: conversationId, last_sequence: lastSequence },
      () => {
        clearTimeout(timeout);
        reject(new Error('Unauthorized sync was acknowledged.'));
      },
    );
  });

class RecordingChatRateLimiter implements ChatRateLimiter {
  public readonly calls: ChatRateLimitInput[] = [];
  private readonly delegate = new InMemoryChatRateLimiter();

  public consume(input: ChatRateLimitInput): void {
    this.calls.push(input);
    this.delegate.consume(input);
  }
}

test('real Socket.IO chat namespace authenticates, isolates rooms and projects committed events', async () => {
  const repository = new InMemoryChatRepository();
  const clientSessionId = randomUUID();
  const trainerSessionId = randomUUID();
  repository.addSession(repository.clientId, clientSessionId);
  repository.addSession(repository.trainerId, trainerSessionId);
  const clock = new FixedChatClock(new Date('2026-08-23T10:00:00.000Z'));
  const eventHub = new ChatEventHub();
  const rateLimiter = new RecordingChatRateLimiter();
  const service = new ChatService({
    repository,
    eventPublisher: eventHub,
    rateLimiter,
    imageProcessor: new FakeChatImageProcessor(),
    mediaStore: new FakeChatMediaStore(),
    clock,
    enabled: true,
    photoUploadsEnabled: true,
    mediaUrlTtlSeconds: 300,
    cursorSecret: 'test-only-chat-cursor-secret-with-32-bytes',
  });
  const tokens = new HmacJwtAccessTokenService(
    'test-only-chat-socket-secret-with-more-than-32-characters',
    'kinetra-chat-socket-test',
    'kinetra-chat-socket-pwa-test',
    900,
  );
  const shortTokens = new HmacJwtAccessTokenService(
    'short-lived-chat-socket-secret-with-more-than-32-characters',
    'kinetra-chat-socket-test',
    'kinetra-chat-socket-pwa-test',
    2,
  );
  const validateSocketIdentity = service.validateSocketIdentity.bind(service);
  const accessTokenVerifier = {
    verify: async (token: string) => {
      try {
        return await tokens.verify(token);
      } catch {
        return shortTokens.verify(token);
      }
    },
  };
  const now = new Date();
  const clientToken = (await tokens.issue(repository.clientId, clientSessionId, now)).token;
  const trainerToken = (await tokens.issue(repository.trainerId, trainerSessionId, now)).token;
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, {
    transports: ['websocket'],
    maxHttpBufferSize: 32 * 1024,
  });
  const detach = attachChatRealtime(socketServer, {
    accessTokenVerifier,
    service,
    eventHub,
    rateLimiter,
    allowedOrigins: ['http://allowed.example'],
    trustedProxyHops: 0,
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Socket test server did not expose a TCP address.');
  }

  const url = `http://127.0.0.1:${address.port}/chat`;
  const socketOptions = (accessToken: string): Partial<ManagerOptions & SocketOptions> => ({
    autoConnect: false,
    transports: ['websocket'],
    auth: { accessToken },
    extraHeaders: { Origin: 'http://allowed.example' },
    reconnection: false,
  });
  const clientSocket = io(url, socketOptions(clientToken));
  const trainerSocket = io(url, socketOptions(trainerToken));

  try {
    await Promise.all([connect(clientSocket), connect(trainerSocket)]);

    const trainerConversationEvent = onceEvent<{
      readonly conversation_id: string;
      readonly unread_count: number;
    }>(trainerSocket, 'chat:conversation:updated');
    const conversationResult = await service.createConversation({
      userId: repository.clientId,
      sessionId: clientSessionId,
      ip: '127.0.0.1',
    });
    const conversationEvent = await trainerConversationEvent;
    assert.equal(conversationEvent.conversation_id, conversationResult.conversation.id);
    assert.equal(conversationEvent.unread_count, 0);

    const clientMessageEvent = onceEvent<{ readonly message: { readonly is_mine: boolean } }>(
      clientSocket,
      'chat:message:new',
    );
    const trainerMessageEvent = onceEvent<{ readonly message: { readonly is_mine: boolean } }>(
      trainerSocket,
      'chat:message:new',
    );
    const clientConversationUpdate = onceEvent<{
      readonly conversation_id: string;
      readonly unread_count: number;
    }>(clientSocket, 'chat:conversation:updated');
    const trainerConversationUpdate = onceEvent<{
      readonly conversation_id: string;
      readonly unread_count: number;
    }>(trainerSocket, 'chat:conversation:updated');
    const clientMessageId = randomUUID();
    await service.sendMessage(
      {
        userId: repository.clientId,
        sessionId: clientSessionId,
        ip: '127.0.0.1',
      },
      conversationResult.conversation.id,
      { client_message_id: clientMessageId, kind: 'text', text: 'Сообщение' },
    );
    const [clientProjection, trainerProjection, clientUpdate, trainerUpdate] = await Promise.all([
      clientMessageEvent,
      trainerMessageEvent,
      clientConversationUpdate,
      trainerConversationUpdate,
    ]);
    assert.equal(clientProjection.message.is_mine, true);
    assert.equal(trainerProjection.message.is_mine, false);
    assert.equal(clientUpdate.conversation_id, conversationResult.conversation.id);
    assert.equal(clientUpdate.unread_count, 0);
    assert.equal(trainerUpdate.conversation_id, conversationResult.conversation.id);
    assert.equal(trainerUpdate.unread_count, 1);
    assert.equal(repository.peekConversation()?.lastMessageSequence, 1, 'event follows commit');

    const noReplayEvent = expectNoEvent(trainerSocket, 'chat:message:new');
    await service.sendMessage(
      {
        userId: repository.clientId,
        sessionId: clientSessionId,
        ip: '127.0.0.1',
      },
      conversationResult.conversation.id,
      { client_message_id: clientMessageId, kind: 'text', text: 'Сообщение' },
    );
    await noReplayEvent;

    const sync = await syncSocket(clientSocket, conversationResult.conversation.id, 1);
    assert.deepEqual(sync, { delta_required: true });
    assert.ok(
      rateLimiter.calls.some(
        (call) => call.scope === 'history' && call.key === `principal:${repository.clientId}`,
      ),
      'chat:sync is covered by the durable-history principal rate limit',
    );

    const disallowed = io(url, {
      ...socketOptions(clientToken),
      extraHeaders: { Origin: 'http://evil.example' },
    });
    assert.equal(await expectConnectError(disallowed), 'CHAT_ORIGIN_REJECTED');

    const queryToken = io(url, {
      autoConnect: false,
      transports: ['websocket'],
      query: { accessToken: clientToken },
      extraHeaders: { Origin: 'http://allowed.example' },
      reconnection: false,
    });
    assert.equal(await expectConnectError(queryToken), 'AUTHENTICATION_REQUIRED');

    const malformed = io(url, {
      ...socketOptions('not-a-token'),
    });
    assert.equal(await expectConnectError(malformed), 'AUTHENTICATION_REQUIRED');

    const missingToken = io(url, {
      autoConnect: false,
      transports: ['websocket'],
      extraHeaders: { Origin: 'http://allowed.example' },
      reconnection: false,
    });
    assert.equal(await expectConnectError(missingToken), 'AUTHENTICATION_REQUIRED');

    const expiredToken = (
      await shortTokens.issue(repository.clientId, clientSessionId, new Date(Date.now() - 10_000))
    ).token;
    const expired = io(url, socketOptions(expiredToken));
    assert.equal(await expectConnectError(expired), 'AUTHENTICATION_REQUIRED');

    const inactiveSessionToken = (await tokens.issue(repository.clientId, randomUUID(), new Date()))
      .token;
    const inactiveSession = io(url, socketOptions(inactiveSessionToken));
    assert.equal(await expectConnectError(inactiveSession), 'AUTHENTICATION_REQUIRED');

    const deletedUserId = randomUUID();
    const deletedSessionId = randomUUID();
    repository.addActor({
      userId: deletedUserId,
      role: 'client',
      onboardingStatus: 'active',
      displayName: 'Удалённый аккаунт',
      avatarUrl: null,
    });
    repository.addSession(deletedUserId, deletedSessionId);
    const deletedUserToken = (await tokens.issue(deletedUserId, deletedSessionId, new Date()))
      .token;
    repository.removeActor(deletedUserId);
    const deletedAccount = io(url, socketOptions(deletedUserToken));
    assert.equal(await expectConnectError(deletedAccount), 'AUTHENTICATION_REQUIRED');

    const spoofedRole = io(url, {
      ...socketOptions(clientToken),
      auth: { accessToken: clientToken, role: 'trainer' },
    });
    assert.equal(await expectConnectError(spoofedRole), 'AUTHENTICATION_REQUIRED');

    const secondClientId = randomUUID();
    const secondClientSessionId = randomUUID();
    const secondTrainerId = randomUUID();
    const secondTrainerSessionId = randomUUID();
    repository.addActor({
      userId: secondClientId,
      role: 'client',
      onboardingStatus: 'active',
      displayName: 'Мария',
      avatarUrl: null,
    });
    repository.addActor({
      userId: secondTrainerId,
      role: 'trainer',
      onboardingStatus: 'survey_pending',
      displayName: 'Второй тренер',
      avatarUrl: null,
    });
    repository.addSession(secondClientId, secondClientSessionId);
    repository.addSession(secondTrainerId, secondTrainerSessionId);
    const secondClientToken = (
      await tokens.issue(secondClientId, secondClientSessionId, new Date())
    ).token;
    const secondTrainerToken = (
      await tokens.issue(secondTrainerId, secondTrainerSessionId, new Date())
    ).token;
    const secondClientSocket = io(url, socketOptions(secondClientToken));
    const secondTrainerSocket = io(url, socketOptions(secondTrainerToken));
    await Promise.all([connect(secondClientSocket), connect(secondTrainerSocket)]);
    const secondConversation = await service.createConversation({
      userId: secondClientId,
      sessionId: secondClientSessionId,
      ip: '127.0.0.1',
    });
    const staleSecondConversation = repository.peekConversationById(
      secondConversation.conversation.id,
    );
    assert.notEqual(staleSecondConversation, null);
    const reassignedDraftKey = `chat/test/${randomUUID()}.webp`;
    const reassignedDraft = await repository.reservePhoto({
      id: randomUUID(),
      conversationId: secondConversation.conversation.id,
      uploaderUserId: repository.trainerId,
      clientUploadId: randomUUID(),
      inputSha256: 'a'.repeat(64),
      objectKey: reassignedDraftKey,
      expiresAt: new Date(clock.now().getTime() + 60_000),
      leaseExpiresAt: new Date(clock.now().getTime() + 30_000),
      now: clock.now(),
    });
    assert.equal(reassignedDraft.kind, 'reserved');
    assert.equal(
      await repository.reassignTrainer({
        fromTrainerUserId: repository.trainerId,
        toTrainerUserId: secondTrainerId,
        conversationIds: [secondConversation.conversation.id],
        now: clock.now(),
      }),
      1,
    );
    assert.equal(
      await repository.findPhotoStatus(
        reassignedDraft.kind === 'reserved' ? reassignedDraft.photo.id : randomUUID(),
        repository.trainerId,
      ),
      null,
    );
    assert.equal(repository.deletionJob(reassignedDraftKey)?.completed, false);

    clientSocket.emit('join', `account:${secondTrainerId}`);
    const secondClientMessageEvent = onceEvent<{
      readonly message: { readonly is_mine: boolean };
    }>(secondClientSocket, 'chat:message:new');
    const assignedTrainerMessageEvent = onceEvent<{
      readonly message: { readonly is_mine: boolean };
    }>(secondTrainerSocket, 'chat:message:new');
    const assignedTrainerConversationUpdate = onceEvent<{
      readonly unread_count: number;
    }>(secondTrainerSocket, 'chat:conversation:updated');
    const clientAIsolation = expectNoEvent(clientSocket, 'chat:message:new');
    const unassignedTrainerIsolation = expectNoEvent(trainerSocket, 'chat:message:new');
    const committedSecondMessage = await repository.sendMessage({
      userId: secondClientId,
      conversationId: secondConversation.conversation.id,
      clientMessageId: randomUUID(),
      requestFingerprint: 'b'.repeat(64),
      kind: 'text',
      body: 'Изолированное сообщение',
      photoId: null,
      now: clock.now(),
    });
    assert.equal(committedSecondMessage.kind, 'created');

    if (committedSecondMessage.kind !== 'created') {
      throw new Error('Expected committed second conversation message.');
    }

    await eventHub.publish({
      kind: 'message_created',
      conversation: staleSecondConversation!,
      message: committedSecondMessage.message,
    });
    const [secondClientProjection, assignedTrainerProjection, assignedTrainerUpdate] =
      await Promise.all([
        secondClientMessageEvent,
        assignedTrainerMessageEvent,
        assignedTrainerConversationUpdate,
        clientAIsolation,
        unassignedTrainerIsolation,
      ]);
    assert.equal(secondClientProjection.message.is_mine, true);
    assert.equal(assignedTrainerProjection.message.is_mine, false);
    assert.equal(assignedTrainerUpdate.unread_count, 1);

    await expectNoSyncAcknowledgement(clientSocket, secondConversation.conversation.id, 0);

    const clientReadEvent = onceEvent<{
      readonly reader_role: string;
      readonly through_sequence: number;
    }>(clientSocket, 'chat:read:updated');
    const trainerReadEvent = onceEvent<{
      readonly reader_role: string;
      readonly through_sequence: number;
    }>(trainerSocket, 'chat:read:updated');
    const otherClientReadIsolation = expectNoEvent(secondClientSocket, 'chat:read:updated');
    const otherTrainerReadIsolation = expectNoEvent(secondTrainerSocket, 'chat:read:updated');
    await service.markRead(
      {
        userId: repository.trainerId,
        sessionId: trainerSessionId,
        ip: '127.0.0.1',
      },
      conversationResult.conversation.id,
      1,
    );
    const [clientRead, trainerRead] = await Promise.all([
      clientReadEvent,
      trainerReadEvent,
      otherClientReadIsolation,
      otherTrainerReadIsolation,
    ]);
    assert.deepEqual(clientRead, {
      conversation_id: conversationResult.conversation.id,
      reader_role: 'trainer',
      through_sequence: 1,
      read_at: clock.now().toISOString(),
    });
    assert.deepEqual(trainerRead, clientRead);

    const inactiveEvent = onceEvent<{ readonly reason: string }>(
      secondClientSocket,
      'chat:session:invalidated',
    );
    const inactiveDisconnect = onceEvent<string>(secondClientSocket, 'disconnect');
    const revokedMessagePrivacy = expectNoEvent(secondClientSocket, 'chat:message:new');
    repository.revokeSession(secondClientId, secondClientSessionId);
    await service.sendMessage(
      {
        userId: secondTrainerId,
        sessionId: secondTrainerSessionId,
        ip: '127.0.0.1',
      },
      secondConversation.conversation.id,
      { client_message_id: randomUUID(), kind: 'text', text: 'После отзыва сессии' },
    );
    assert.deepEqual(await inactiveEvent, { reason: 'session_inactive' });
    await inactiveDisconnect;
    await revokedMessagePrivacy;

    const accountChangedEvent = onceEvent<{ readonly reason: string }>(
      secondTrainerSocket,
      'chat:session:invalidated',
    );
    const accountChangedDisconnect = onceEvent<string>(secondTrainerSocket, 'disconnect');
    repository.removeActor(secondTrainerId);
    secondTrainerSocket.emit(
      'chat:sync',
      { conversation_id: secondConversation.conversation.id, last_sequence: 1 },
      () => undefined,
    );
    assert.deepEqual(await accountChangedEvent, { reason: 'account_changed' });
    await accountChangedDisconnect;

    const capSockets = Array.from({ length: 5 }, () => io(url, socketOptions(clientToken)));
    const capResults = await Promise.all(
      capSockets.map(async (socket) => {
        try {
          await connect(socket);
          return 'connected';
        } catch (error) {
          return (error as Error & { data?: { readonly code?: string } }).data?.code;
        }
      }),
    );
    assert.equal(capResults.filter((result) => result === 'connected').length, 4);
    assert.deepEqual(
      capResults.filter((result) => result !== 'connected'),
      ['CHAT_RATE_LIMITED'],
    );

    for (const socket of capSockets) {
      socket.disconnect();
    }

    clientSocket.disconnect();
    await service.sendMessage(
      {
        userId: repository.trainerId,
        sessionId: trainerSessionId,
        ip: '127.0.0.1',
      },
      conversationResult.conversation.id,
      { client_message_id: randomUUID(), kind: 'text', text: 'Сообщение вне сети' },
    );
    await connect(clientSocket);
    assert.deepEqual(await syncSocket(clientSocket, conversationResult.conversation.id, 1), {
      delta_required: true,
    });
    const catchUp = await service.listMessages(
      {
        userId: repository.clientId,
        sessionId: clientSessionId,
        ip: '127.0.0.1',
      },
      conversationResult.conversation.id,
      { after_sequence: 1, limit: 30 },
    );
    assert.equal(catchUp.messages.length, 1);
    assert.equal(catchUp.messages[0]?.sequence, 2);
    assert.equal(catchUp.messages[0]?.text, 'Сообщение вне сети');

    const expiringToken = (
      await shortTokens.issue(repository.clientId, clientSessionId, new Date())
    ).token;
    const expiringClaims = await shortTokens.verify(expiringToken);
    const expiresAtMilliseconds = expiringClaims.exp * 1_000;
    const expiringSocket = io(url, socketOptions(expiringToken));
    await connect(expiringSocket);
    let releaseIdentityValidation!: () => void;
    let signalIdentityValidationStarted!: () => void;
    const identityValidationGate = new Promise<void>((resolve) => {
      releaseIdentityValidation = resolve;
    });
    const identityValidationStarted = new Promise<void>((resolve) => {
      signalIdentityValidationStarted = resolve;
    });
    let holdExpiringClientValidation = true;
    service.validateSocketIdentity = async (userId, sessionId, expectedRole) => {
      if (holdExpiringClientValidation && userId === repository.clientId) {
        holdExpiringClientValidation = false;
        signalIdentityValidationStarted();
        await identityValidationGate;
      }

      return validateSocketIdentity(userId, sessionId, expectedRole);
    };
    const expiryEvent = onceEvent<{ readonly reason: string }>(
      expiringSocket,
      'chat:session:invalidated',
      8_000,
    );
    const expiryDisconnect = onceEvent<string>(expiringSocket, 'disconnect', 8_000);
    const postExpirySend = service.sendMessage(
      {
        userId: repository.trainerId,
        sessionId: trainerSessionId,
        ip: '127.0.0.1',
      },
      conversationResult.conversation.id,
      {
        client_message_id: randomUUID(),
        kind: 'text',
        text: 'Сообщение на границе истечения access token',
      },
    );
    await identityValidationStarted;
    const waitBeforeBoundary = expiresAtMilliseconds - Date.now() - 50;
    if (waitBeforeBoundary > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitBeforeBoundary));
    }
    const noPostExpiryPrivateEvent = expectNoEvent(expiringSocket, 'chat:message:new', 250);
    while (Date.now() < expiresAtMilliseconds) {
      // Intentionally keep the expiry timer pending while validation crosses exp.
    }
    releaseIdentityValidation();
    await postExpirySend;
    assert.deepEqual(await expiryEvent, { reason: 'token_expired' });
    const invalidatedAtMilliseconds = Date.now();
    assert.ok(
      invalidatedAtMilliseconds <= expiresAtMilliseconds + 500,
      `socket invalidation lagged JWT exp by ${invalidatedAtMilliseconds - expiresAtMilliseconds}ms`,
    );
    await noPostExpiryPrivateEvent;
    await expiryDisconnect;
    service.validateSocketIdentity = validateSocketIdentity;

    const freshToken = (await shortTokens.issue(repository.clientId, clientSessionId, new Date()))
      .token;
    expiringSocket.auth = { accessToken: freshToken };
    await connect(expiringSocket);
    assert.equal(expiringSocket.connected, true);
    expiringSocket.disconnect();

    console.log('KINETRA_T12_SOCKET_AUTHORIZATION=PASS');
  } finally {
    service.validateSocketIdentity = validateSocketIdentity;
    clientSocket.disconnect();
    trainerSocket.disconnect();
    detach();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  }
});
