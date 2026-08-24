import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpError } from '../src/auth/errors.js';
import { ChatEventHub } from '../src/chat/event-hub.js';
import type { ChatRateLimitInput, ChatRateLimiter } from '../src/chat/rate-limit.js';
import { ChatService } from '../src/chat/service.js';
import {
  FakeChatImageProcessor,
  FakeChatMediaStore,
  FixedChatClock,
} from './support/fake-chat-media.js';
import { InMemoryChatRepository } from './support/in-memory-chat.repository.js';

class RecordingCreateLimiter implements ChatRateLimiter {
  public readonly calls: ChatRateLimitInput[] = [];

  public constructor(private readonly rejectIp: boolean) {}

  public consume(input: ChatRateLimitInput): void {
    this.calls.push(input);

    if (this.rejectIp && input.scope === 'conversation_create' && input.key.startsWith('ip:')) {
      throw new HttpError(429, 'CHAT_RATE_LIMITED', 'Too many chat requests. Try again later.');
    }
  }
}

class CountingChatRepository extends InMemoryChatRepository {
  public databaseCalls = 0;

  public override async isSessionActive(
    userId: string,
    sessionId: string,
    now: Date,
  ): Promise<boolean> {
    this.databaseCalls += 1;
    return super.isSessionActive(userId, sessionId, now);
  }
}

class LockedConcurrentCreateRepository extends InMemoryChatRepository {
  public arrivals = 0;
  public maximumConcurrentCallers = 0;
  public lockAcquisitions = 0;

  private activeCallers = 0;
  private readonly bothCallersArrived: Promise<void>;
  private signalBothCallersArrived!: () => void;
  private lockTail: Promise<void> = Promise.resolve();

  public constructor() {
    super();
    this.bothCallersArrived = new Promise<void>((resolve) => {
      this.signalBothCallersArrived = resolve;
    });
  }

  public override async createOrGetConversation(clientUserId: string, now: Date) {
    this.arrivals += 1;
    this.activeCallers += 1;
    this.maximumConcurrentCallers = Math.max(this.maximumConcurrentCallers, this.activeCallers);

    if (this.arrivals === 2) {
      this.signalBothCallersArrived();
    }

    await this.bothCallersArrived;
    const previousLock = this.lockTail;
    let releaseLock!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previousLock;
    this.lockAcquisitions += 1;

    try {
      await Promise.resolve();
      return await super.createOrGetConversation(clientUserId, now);
    } finally {
      this.activeCallers -= 1;
      releaseLock();
    }
  }
}

const createService = (
  repository: InMemoryChatRepository,
  rateLimiter: ChatRateLimiter,
  eventHub = new ChatEventHub(),
): { readonly service: ChatService; readonly eventHub: ChatEventHub } => ({
  service: new ChatService({
    repository,
    eventPublisher: eventHub,
    rateLimiter,
    imageProcessor: new FakeChatImageProcessor(),
    mediaStore: new FakeChatMediaStore(),
    clock: new FixedChatClock(new Date('2026-08-24T10:00:00.000Z')),
    enabled: true,
    photoUploadsEnabled: true,
    mediaUrlTtlSeconds: 300,
    cursorSecret: 'test-only-chat-merge-readiness-secret',
  }),
  eventHub,
});

test('conversation creation consumes principal and IP admission before any repository work', async () => {
  const repository = new CountingChatRepository();
  const sessionId = randomUUID();
  repository.addSession(repository.clientId, sessionId);
  const limiter = new RecordingCreateLimiter(true);
  const { service } = createService(repository, limiter);

  await assert.rejects(
    service.createConversation({
      userId: repository.clientId,
      sessionId,
      ip: '203.0.113.7',
    }),
    (error: unknown) => error instanceof HttpError && error.statusCode === 429,
  );

  assert.deepEqual(
    limiter.calls.map(({ scope, key }) => ({ scope, key })),
    [
      { scope: 'conversation_create', key: `principal:${repository.clientId}` },
      { scope: 'conversation_create', key: 'ip:203.0.113.7' },
    ],
  );
  assert.equal(repository.databaseCalls, 0);
});

test('two genuinely overlapping admitted creates serialize and publish one canonical event', async () => {
  const repository = new LockedConcurrentCreateRepository();
  const sessionId = randomUUID();
  repository.addSession(repository.clientId, sessionId);
  const limiter = new RecordingCreateLimiter(false);
  const eventHub = new ChatEventHub();
  const { service } = createService(repository, limiter, eventHub);
  let creationEvents = 0;
  const unsubscribe = eventHub.subscribe(async (event) => {
    if (event.kind === 'conversation_updated') {
      creationEvents += 1;
    }
  });

  try {
    const context = {
      userId: repository.clientId,
      sessionId,
      ip: '198.51.100.4',
    } as const;
    const results = await Promise.all([
      service.createConversation(context),
      service.createConversation(context),
    ]);

    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(results[0]?.conversation.id, results[1]?.conversation.id);
    assert.equal(creationEvents, 1);
    assert.equal(repository.arrivals, 2);
    assert.equal(
      repository.maximumConcurrentCallers,
      2,
      'both service requests must overlap before the repository lock is released',
    );
    assert.equal(repository.lockAcquisitions, 2);
  } finally {
    unsubscribe();
  }
});
