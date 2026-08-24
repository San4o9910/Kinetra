import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';

import pg from 'pg';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { Server as SocketServer } from 'socket.io';

import type { AccessTokenClaims } from '../src/auth/tokens.js';
import { ChatEventHub } from '../src/chat/event-hub.js';
import { PostgresChatRepository } from '../src/chat/postgres-chat.repository.js';
import { NoopChatRateLimiter } from '../src/chat/rate-limit.js';
import { attachChatRealtime } from '../src/chat/realtime.js';
import type { ChatActor, ChatConversationSnapshot, ChatRole } from '../src/chat/repository.js';
import type { ChatService } from '../src/chat/service.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

interface TestIdentity {
  readonly userId: string;
  readonly sessionId: string;
  readonly role: ChatRole;
}

const withDeadline = async <T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = 3_000,
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const onceSocketEvent = async (socket: Socket, eventName: string): Promise<void> =>
  new Promise<void>((resolve) => {
    socket.once(eventName, () => resolve());
  });

class PostgresRealtimeServiceDouble {
  public readonly identities = new Map<string, TestIdentity>();
  public validationGate: Promise<void> = Promise.resolve();
  public validationFailureUserId: string | null = null;
  public validationFailureInjected = false;
  public validationCallCount = 0;
  public validationSnapshotCount = 0;
  public readonly validationBarrierReached: Promise<void>;

  private readonly validationSnapshots = new WeakSet<ChatConversationSnapshot>();
  private signalValidationBarrier!: () => void;

  public constructor(
    private readonly repository: PostgresChatRepository,
    private readonly expectedPublicationCount: number,
  ) {
    this.validationBarrierReached = new Promise<void>((resolve) => {
      this.signalValidationBarrier = resolve;
    });
  }

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
    expectedRole: ChatRole,
  ): Promise<'active' | 'session_inactive' | 'account_changed'> {
    const identity = this.identities.get(`${userId}:${sessionId}`);

    if (identity === undefined) {
      return 'session_inactive';
    }

    return identity.role === expectedRole ? 'active' : 'account_changed';
  }

  public async getRealtimeConversation(
    conversationId: string,
  ): Promise<ChatConversationSnapshot | null> {
    return this.repository.getRealtimeConversation(conversationId);
  }

  public async validateRealtimeRecipient(
    snapshot: ChatConversationSnapshot,
    userId: string,
    sessionId: string,
    role: ChatRole,
  ): Promise<'active' | 'session_inactive' | 'account_changed' | 'not_participant'> {
    this.validationCallCount += 1;

    if (!this.validationSnapshots.has(snapshot)) {
      this.validationSnapshots.add(snapshot);
      this.validationSnapshotCount += 1;
    }

    if (
      this.validationCallCount === this.expectedPublicationCount * 2 &&
      this.validationSnapshotCount === this.expectedPublicationCount
    ) {
      this.signalValidationBarrier();
    }

    await this.validationGate;

    try {
      if (!this.validationFailureInjected && userId === this.validationFailureUserId) {
        this.validationFailureInjected = true;
        throw new Error('Injected recipient validation failure.');
      }

      const identity = this.identities.get(`${userId}:${sessionId}`);

      if (identity === undefined) {
        return 'session_inactive';
      }

      if (identity.role !== role) {
        return 'account_changed';
      }

      const current = await this.repository.findRealtimeRecipientConversation(
        userId,
        role,
        snapshot.id,
      );
      return current !== null &&
        current.client.userId === snapshot.client.userId &&
        current.trainer.userId === snapshot.trainer.userId
        ? 'active'
        : 'not_participant';
    } finally {
      this.validationCallCount -= 1;
    }
  }
}

test(
  'PostgreSQL realtime fan-out releases pool slots before validation at max=1 and max=10',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async (context) => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL realtime integration test.');
    }

    for (const maximumPoolSize of [1, 10]) {
      await context.test(`pool max=${maximumPoolSize}`, async () => {
        const applicationName = `kinetra-realtime-${maximumPoolSize}-${randomUUID()}`;
        const pool = new Pool({
          connectionString: databaseUrl,
          max: maximumPoolSize,
          application_name: applicationName,
        });
        const repository = new PostgresChatRepository(pool);
        const clientId = randomUUID();
        const oldTrainerId = randomUUID();
        const newTrainerId = randomUUID();
        const conversationId = randomUUID();
        const clientSessionId = randomUUID();
        const trainerSessionId = randomUUID();
        const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';
        const now = new Date('2026-08-24T12:00:00.000Z');
        const httpServer = createServer();
        const socketServer = new SocketServer(httpServer, {
          transports: ['websocket'],
          maxHttpBufferSize: 32 * 1024,
        });
        const eventHub = new ChatEventHub();
        const publicationCount = maximumPoolSize;
        const service = new PostgresRealtimeServiceDouble(repository, publicationCount);
        const claimsByToken = new Map<string, AccessTokenClaims>();
        const clients = new Set<Socket>();
        let releaseValidation!: () => void;
        let publications: Promise<void>[] = [];
        const validationGate = new Promise<void>((resolve) => {
          releaseValidation = resolve;
        });
        service.validationGate = validationGate;
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
          service: service as unknown as ChatService,
          eventHub,
          rateLimiter: new NoopChatRateLimiter(),
          allowedOrigins: ['http://allowed.example'],
          trustedProxyHops: 0,
        });

        try {
          await pool.query(
            `INSERT INTO users (
               id, email, password_hash, email_verified, onboarding_status, first_name
             )
             VALUES
               ($1, $2, $7, true, 'active', 'Клиент realtime'),
               ($3, $4, $7, true, 'survey_pending', NULL),
               ($5, $6, $7, true, 'survey_pending', NULL)`,
            [
              clientId,
              `chat-realtime-client-${clientId}@example.com`,
              oldTrainerId,
              `chat-realtime-old-trainer-${oldTrainerId}@example.com`,
              newTrainerId,
              `chat-realtime-new-trainer-${newTrainerId}@example.com`,
              passwordHash,
            ],
          );
          await pool.query(
            `INSERT INTO trainer_profiles (
               user_id, display_name, is_active, is_default, created_at, updated_at
             )
             VALUES ($1, 'Старый тренер', true, false, $3, $3),
                    ($2, 'Новый тренер', true, false, $3, $3)`,
            [oldTrainerId, newTrainerId, now],
          );
          await pool.query(
            `INSERT INTO chat_conversations (
               id, client_user_id, trainer_user_id, created_at, updated_at
             )
             VALUES ($1, $2, $3, $4, $4)`,
            [conversationId, clientId, oldTrainerId, now],
          );
          const snapshot = await repository.getRealtimeConversation(conversationId);
          assert.notEqual(snapshot, null);
          const clientIdentity: TestIdentity = {
            userId: clientId,
            sessionId: clientSessionId,
            role: 'client',
          };
          const trainerIdentity: TestIdentity = {
            userId: oldTrainerId,
            sessionId: trainerSessionId,
            role: 'trainer',
          };
          service.addIdentity(clientIdentity);
          service.addIdentity(trainerIdentity);

          await new Promise<void>((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(0, '127.0.0.1', () => resolve());
          });
          const address = httpServer.address();

          if (address === null || typeof address === 'string') {
            throw new Error('PostgreSQL realtime test server did not expose a TCP address.');
          }

          const connectIdentity = async (identity: TestIdentity): Promise<Socket> => {
            const token = `test-${randomUUID()}`;
            const nowSeconds = Math.floor(Date.now() / 1_000);
            claimsByToken.set(token, {
              sub: identity.userId,
              sid: identity.sessionId,
              type: 'access',
              iss: 'kinetra-realtime-postgres-test',
              aud: 'kinetra-realtime-postgres-test',
              iat: nowSeconds,
              exp: nowSeconds + 600,
              jti: randomUUID(),
            });
            const options: Partial<ManagerOptions & SocketOptions> = {
              autoConnect: false,
              transports: ['websocket'],
              auth: { accessToken: token },
              extraHeaders: { Origin: 'http://allowed.example' },
              reconnection: false,
            };
            const socket = io(`http://127.0.0.1:${address.port}/chat`, options);
            clients.add(socket);
            await withDeadline(
              new Promise<void>((resolve, reject) => {
                socket.once('connect', () => resolve());
                socket.once('connect_error', reject);
                socket.connect();
              }),
              'socket connection',
            );
            return socket;
          };
          const clientSocket = await connectIdentity(clientIdentity);
          const trainerSocket = await connectIdentity(trainerIdentity);
          let clientUpdates = 0;
          let trainerUpdates = 0;
          clientSocket.on('chat:conversation:updated', () => {
            clientUpdates += 1;
          });
          trainerSocket.on('chat:conversation:updated', () => {
            trainerUpdates += 1;
          });
          publications = Array.from({ length: publicationCount }, () =>
            eventHub.publish({
              kind: 'conversation_updated',
              conversation: snapshot!,
            }),
          );
          await withDeadline(
            service.validationBarrierReached,
            `${publicationCount} concurrent publications entering recipient validation`,
          );
          assert.equal(service.validationSnapshotCount, publicationCount);
          assert.equal(
            service.validationCallCount,
            publicationCount * 2,
            'both active recipient sockets must be waiting at the validation barrier',
          );

          const unrelatedResult = await withDeadline(
            pool.query<{ readonly available: number }>('SELECT 1 AS available'),
            `unrelated query with pool max=${maximumPoolSize}`,
          );
          assert.equal(unrelatedResult.rows[0]?.available, 1);

          const clientDisconnected = onceSocketEvent(clientSocket, 'disconnect');

          if (maximumPoolSize === 1) {
            const reassignment = await withDeadline(
              pool.query(
                `UPDATE chat_conversations
                 SET trainer_user_id = $2
                 WHERE id = $1`,
                [conversationId, newTrainerId],
              ),
              `trainer reassignment with pool max=${maximumPoolSize}`,
            );
            assert.equal(reassignment.rowCount, 1);
            service.identities.delete(`${clientId}:${clientSessionId}`);
          } else {
            service.validationFailureUserId = clientId;
          }

          releaseValidation();
          await withDeadline(
            Promise.all(publications),
            `${publicationCount} fan-out publications with pool max=${maximumPoolSize}`,
          );
          await withDeadline(clientDisconnected, 'revoked or failed recipient disconnect');

          const trainerFlushed = onceSocketEvent(trainerSocket, 'test:flush');
          socketServer
            .of('/chat')
            .to(`account:${oldTrainerId}`)
            .emit('test:flush', { publication_count: publicationCount });
          await withDeadline(trainerFlushed, 'trainer transport flush');

          if (maximumPoolSize === 1) {
            assert.equal(clientUpdates, 0, 'a revoked session must not receive a stale event');
            assert.equal(trainerUpdates, 0, 'a reassigned trainer must not receive a stale event');
            assert.equal(
              trainerSocket.connected,
              true,
              'a reassigned trainer is silently fenced without disconnecting the socket',
            );
          } else {
            assert.equal(service.validationFailureInjected, true);
            assert.equal(
              trainerUpdates,
              publicationCount,
              'one recipient validation failure must not block the other recipient or DB APIs',
            );
          }
        } finally {
          releaseValidation();

          await Promise.all(
            publications.map(async (publication) => publication.catch(() => undefined)),
          );

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

          try {
            await pool.query('DELETE FROM chat_conversations WHERE id = $1', [conversationId]);
            await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
              [clientId, oldTrainerId, newTrainerId],
            ]);
          } finally {
            await pool.end();
          }
        }
      });
    }
  },
);
