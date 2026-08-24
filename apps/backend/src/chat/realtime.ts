import type { Server as SocketServer, Socket } from 'socket.io';

import { HttpError } from '../auth/errors.js';
import type { AccessTokenClaims } from '../auth/tokens.js';
import type { AccessTokenVerifier } from '../auth/middleware.js';
import { resolveChatClientIp } from './client-ip.js';
import type { ChatDomainEvent, ChatEventHub } from './event-hub.js';
import type { ChatRateLimiter } from './rate-limit.js';
import type { ChatActor, ChatConversationSnapshot, ChatRole } from './repository.js';
import { conversationUnreadFor, projectMessageFor, type ChatService } from './service.js';

export interface ChatRealtimeDependencies {
  readonly accessTokenVerifier: AccessTokenVerifier;
  readonly service: ChatService;
  readonly eventHub: ChatEventHub;
  readonly rateLimiter: ChatRateLimiter;
  readonly allowedOrigins: readonly string[];
  readonly trustedProxyHops: number;
}

interface SocketIdentity {
  readonly actor: ChatActor;
  readonly claims: AccessTokenClaims;
  readonly clientIp: string;
}

interface SocketError extends Error {
  data?: { readonly code: string };
}

const socketError = (code: string, message: string): SocketError => {
  const error: SocketError = new Error(message);
  error.data = { code };
  return error;
};

const roomFor = (userId: string): string => `account:${userId}`;

const accessTokenExpired = (claims: AccessTokenClaims): boolean => Date.now() >= claims.exp * 1_000;

const accessTokenFrom = (socket: Socket): string | null => {
  if (
    Object.hasOwn(socket.handshake.query, 'accessToken') ||
    Object.hasOwn(socket.handshake.query, 'token')
  ) {
    return null;
  }

  const auth = socket.handshake.auth as unknown;

  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) {
    return null;
  }

  const entries = Object.entries(auth);

  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== 'accessToken' ||
    typeof entries[0][1] !== 'string' ||
    entries[0][1].length < 1
  ) {
    return null;
  }

  return entries[0][1];
};

const messageSummary = (conversation: ChatConversationSnapshot) => {
  const message = conversation.lastMessage;

  if (message === null) {
    return null;
  }

  return {
    kind: message.kind,
    preview: message.kind === 'photo' ? '📷 Фото' : (message.body ?? ''),
    created_at: message.createdAt.toISOString(),
  };
};

const conversationUpdateFor = (conversation: ChatConversationSnapshot, role: ChatRole) => ({
  conversation_id: conversation.id,
  last_message: messageSummary(conversation),
  unread_count: conversationUnreadFor(conversation, role),
});

export const attachChatRealtime = (
  socketServer: SocketServer,
  dependencies: ChatRealtimeDependencies,
): (() => void) => {
  const namespace = socketServer.of('/chat');
  const identities = new WeakMap<Socket, SocketIdentity>();
  const activeCounts = new Map<string, number>();
  const countedSockets = new WeakSet<Socket>();

  const releaseConnectionCount = (socket: Socket, userId: string): void => {
    if (!countedSockets.has(socket)) {
      return;
    }

    countedSockets.delete(socket);
    const remaining = Math.max(0, (activeCounts.get(userId) ?? 1) - 1);

    if (remaining === 0) {
      activeCounts.delete(userId);
    } else {
      activeCounts.set(userId, remaining);
    }
  };

  const socketsFor = (userId: string): Socket[] =>
    [...namespace.sockets.values()].filter(
      (socket) => identities.get(socket)?.actor.userId === userId,
    );

  const invalidateSocket = (
    socket: Socket,
    reason: 'session_inactive' | 'account_changed' | 'token_expired',
  ): void => {
    socket.emit('chat:session:invalidated', { reason });
    socket.disconnect(true);
  };

  const emitToActiveAccount = async (
    userId: string,
    eventName: string,
    payload: unknown,
  ): Promise<void> => {
    await Promise.all(
      socketsFor(userId).map(async (socket) => {
        const identity = identities.get(socket);

        if (identity === undefined) {
          return;
        }

        if (accessTokenExpired(identity.claims)) {
          invalidateSocket(socket, 'token_expired');
          return;
        }

        let status: 'active' | 'session_inactive' | 'account_changed' = 'session_inactive';

        try {
          status = await dependencies.service.validateSocketIdentity(
            userId,
            identity.claims.sid,
            identity.actor.role,
          );
        } catch {
          status = 'session_inactive';
        }

        if (status !== 'active') {
          invalidateSocket(socket, status);
          return;
        }

        // Identity validation may cross the JWT expiry boundary. Re-check
        // immediately before every private fan-out so an in-flight lookup can
        // never create a post-expiry delivery window.
        if (accessTokenExpired(identity.claims)) {
          invalidateSocket(socket, 'token_expired');
          return;
        }

        socket.emit(eventName, payload);
      }),
    );
  };

  const emitConversationUpdate = async (conversation: ChatConversationSnapshot): Promise<void> => {
    await Promise.all([
      emitToActiveAccount(
        conversation.client.userId,
        'chat:conversation:updated',
        conversationUpdateFor(conversation, 'client'),
      ),
      emitToActiveAccount(
        conversation.trainer.userId,
        'chat:conversation:updated',
        conversationUpdateFor(conversation, 'trainer'),
      ),
    ]);
  };

  const emitDomainEvent = async (event: ChatDomainEvent): Promise<void> => {
    if (event.kind === 'session_invalidated') {
      for (const socket of socketsFor(event.userId)) {
        invalidateSocket(socket, 'session_inactive');
      }

      return;
    }

    await dependencies.service.withRealtimeConversation(
      event.conversation.id,
      async (conversation) => {
        if (conversation === null) {
          return;
        }

        if (event.kind === 'conversation_updated') {
          await emitConversationUpdate(conversation);
          return;
        }

        if (event.kind === 'message_created') {
          await Promise.all([
            emitToActiveAccount(conversation.client.userId, 'chat:message:new', {
              message: projectMessageFor(event.message, conversation.client.userId),
            }),
            emitToActiveAccount(conversation.trainer.userId, 'chat:message:new', {
              message: projectMessageFor(event.message, conversation.trainer.userId),
            }),
          ]);
          await emitConversationUpdate(conversation);
          return;
        }

        const payload = {
          conversation_id: conversation.id,
          reader_role: event.readerRole,
          through_sequence: event.throughSequence,
          read_at: event.readAt.toISOString(),
        };
        await Promise.all([
          emitToActiveAccount(conversation.client.userId, 'chat:read:updated', payload),
          emitToActiveAccount(conversation.trainer.userId, 'chat:read:updated', payload),
        ]);
      },
    );
  };

  namespace.use((socket, next) => {
    void (async () => {
      const origin = socket.handshake.headers.origin;

      if (origin === undefined || !dependencies.allowedOrigins.includes(origin)) {
        throw socketError('CHAT_ORIGIN_REJECTED', 'Chat connection origin is not allowed.');
      }

      const clientIp = resolveChatClientIp(
        {
          remoteAddress: socket.conn.remoteAddress,
          xForwardedFor: socket.handshake.headers['x-forwarded-for'],
        },
        dependencies.trustedProxyHops,
      );

      dependencies.rateLimiter.consume({
        scope: 'websocket_handshake',
        key: `ip:${clientIp}`,
        maximum: 20,
        windowMs: 60_000,
      });
      const accessToken = accessTokenFrom(socket);

      if (accessToken === null) {
        throw socketError('AUTHENTICATION_REQUIRED', 'A valid access token is required.');
      }

      let claims: AccessTokenClaims;

      try {
        claims = await dependencies.accessTokenVerifier.verify(accessToken);
      } catch {
        throw socketError('AUTHENTICATION_REQUIRED', 'A valid access token is required.');
      }

      const actor = await dependencies.service.getSocketActor(claims.sub, claims.sid);

      if (actor === null || accessTokenExpired(claims)) {
        throw socketError('AUTHENTICATION_REQUIRED', 'A valid access token is required.');
      }

      const maximumConnections = actor.role === 'trainer' ? 10 : 5;

      if ((activeCounts.get(actor.userId) ?? 0) >= maximumConnections) {
        throw socketError('CHAT_RATE_LIMITED', 'Too many active chat connections.');
      }

      activeCounts.set(actor.userId, (activeCounts.get(actor.userId) ?? 0) + 1);
      countedSockets.add(socket);
      socket.conn.once('close', () => releaseConnectionCount(socket, actor.userId));
      identities.set(socket, { actor, claims, clientIp });
    })()
      .then(() => next())
      .catch((error: unknown) => {
        if (error instanceof HttpError) {
          next(socketError(error.code, error.message));
          return;
        }

        next(
          error instanceof Error
            ? error
            : socketError('AUTHENTICATION_REQUIRED', 'Chat authentication failed.'),
        );
      });
  });

  namespace.on('connection', (socket) => {
    const identity = identities.get(socket);

    if (identity === undefined || socket.conn.transport.name !== 'websocket') {
      socket.disconnect(true);
      return;
    }

    const userId = identity.actor.userId;
    void socket.join(roomFor(userId));
    const disconnectDelay = Math.max(0, identity.claims.exp * 1000 - Date.now());
    const expiryTimer = setTimeout(() => {
      invalidateSocket(socket, 'token_expired');
    }, disconnectDelay);

    socket.on(
      'chat:sync',
      (
        payload: unknown,
        acknowledge?: (response: { readonly delta_required: boolean }) => void,
      ) => {
        if (
          typeof payload !== 'object' ||
          payload === null ||
          Array.isArray(payload) ||
          Object.keys(payload).length !== 2 ||
          !Object.hasOwn(payload, 'conversation_id') ||
          !Object.hasOwn(payload, 'last_sequence')
        ) {
          return;
        }

        const typedPayload = payload as {
          readonly conversation_id?: unknown;
          readonly last_sequence?: unknown;
        };
        const lastSequence = typedPayload.last_sequence;

        if (
          typeof typedPayload.conversation_id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            typedPayload.conversation_id,
          ) ||
          !Number.isSafeInteger(lastSequence) ||
          (lastSequence as number) < 0
        ) {
          return;
        }

        void dependencies.service
          .authorizeSocketSync(
            {
              userId,
              sessionId: identity.claims.sid,
              ip: identity.clientIp,
            },
            typedPayload.conversation_id,
            lastSequence as number,
          )
          .then(() => {
            if (accessTokenExpired(identity.claims)) {
              invalidateSocket(socket, 'token_expired');
              return;
            }
            acknowledge?.({ delta_required: true });
          })
          .catch((error: unknown) => {
            if (error instanceof HttpError && error.statusCode === 401) {
              socket.emit('chat:session:invalidated', { reason: 'session_inactive' });
              socket.disconnect(true);
            } else if (error instanceof HttpError && error.statusCode === 403) {
              socket.emit('chat:session:invalidated', { reason: 'account_changed' });
              socket.disconnect(true);
            }
          });
      },
    );

    socket.once('disconnect', () => {
      clearTimeout(expiryTimer);
      releaseConnectionCount(socket, userId);
    });
  });

  let sweepInProgress = false;
  const sweepSessions = async (): Promise<void> => {
    if (sweepInProgress) {
      return;
    }

    sweepInProgress = true;

    try {
      const sockets = [...namespace.sockets.values()];

      for (let offset = 0; offset < sockets.length; offset += 100) {
        await Promise.all(
          sockets.slice(offset, offset + 100).map(async (socket) => {
            const identity = identities.get(socket);

            if (identity === undefined) {
              return;
            }

            let status: 'active' | 'session_inactive' | 'account_changed' = 'session_inactive';

            try {
              status = await dependencies.service.validateSocketIdentity(
                identity.actor.userId,
                identity.claims.sid,
                identity.actor.role,
              );
            } catch {
              status = 'session_inactive';
            }

            if (status !== 'active') {
              invalidateSocket(socket, status);
            }
          }),
        );
      }
    } finally {
      sweepInProgress = false;
    }
  };
  const sweepTimer = setInterval(() => void sweepSessions(), 30_000);
  sweepTimer.unref();
  const unsubscribe = dependencies.eventHub.subscribe((event) => emitDomainEvent(event));

  return () => {
    clearInterval(sweepTimer);
    unsubscribe();
  };
};
