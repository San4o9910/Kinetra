import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpError } from '../src/auth/errors.js';
import { ChatMediaCleanupService } from '../src/chat/cleanup-service.js';
import { NoopChatRateLimiter } from '../src/chat/rate-limit.js';
import { ChatService } from '../src/chat/service.js';
import {
  FakeChatImageProcessor,
  FakeChatMediaStore,
  FixedChatClock,
} from './support/fake-chat-media.js';
import { InMemoryChatRepository } from './support/in-memory-chat.repository.js';

test('media cleanup expires unattached drafts and durably retries object deletion', async () => {
  const repository = new InMemoryChatRepository();
  const start = new Date('2026-08-23T10:00:00.000Z');
  const clock = new FixedChatClock(start);
  const mediaStore = new FakeChatMediaStore();
  const conversation = await repository.createOrGetConversation(repository.clientId, start);
  assert.notEqual(conversation, null);
  const photoId = randomUUID();
  const objectKey = `chat/test/${randomUUID()}.webp`;
  const reserved = await repository.reservePhoto({
    id: photoId,
    conversationId: conversation!.conversation.id,
    uploaderUserId: repository.clientId,
    clientUploadId: randomUUID(),
    inputSha256: 'a'.repeat(64),
    objectKey,
    expiresAt: new Date(start.getTime() + 1_000),
    leaseExpiresAt: new Date(start.getTime() + 500),
    now: start,
  });
  assert.equal(reserved.kind, 'reserved');
  mediaStore.objects.set(objectKey, Buffer.from('normalized'));
  clock.set(new Date(start.getTime() + 2_000));
  const cleanup = new ChatMediaCleanupService(repository, mediaStore, clock);
  const first = await cleanup.runOnce();
  assert.equal(first.stalePhotosRemoved, 1);
  assert.equal(first.deletionsCompleted, 1);
  assert.equal(first.pendingDeletionJobs, 0);
  assert.equal(first.oldestDeletionAgeMs, null);
  assert.equal(mediaStore.objects.has(objectKey), false);
  assert.equal(repository.deletionJob(objectKey)?.completed, true);

  const retryKey = `chat/test/${randomUUID()}.webp`;
  repository.enqueueDeletion(retryKey, clock.now());
  mediaStore.objects.set(retryKey, Buffer.from('normalized'));
  mediaStore.failDelete = true;
  const failed = await cleanup.runOnce();
  assert.equal(failed.deletionsFailed, 1);
  assert.equal(failed.pendingDeletionJobs, 1);
  assert.equal(failed.dueDeletionJobs, 0);
  assert.equal(failed.oldestDeletionAgeMs, 0);
  assert.equal(repository.deletionJob(retryKey)?.completed, false);
  assert.equal(repository.deletionJob(retryKey)?.locked, false);

  mediaStore.failDelete = false;
  clock.set(new Date(clock.now().getTime() + 31_000));
  const recovered = await cleanup.runOnce();
  assert.equal(recovered.deletionsCompleted, 1);
  assert.equal(recovered.pendingDeletionJobs, 0);
  assert.equal(repository.deletionJob(retryKey)?.completed, true);
  assert.equal(mediaStore.objects.has(retryKey), false);
});

test('cleanup reports a safe alertable age for durable deletion backlog', async () => {
  const repository = new InMemoryChatRepository();
  const requestedAt = new Date('2026-08-22T08:00:00.000Z');
  const clock = new FixedChatClock(new Date('2026-08-23T10:00:00.001Z'));
  const mediaStore = new FakeChatMediaStore();
  const objectKey = `chat/test/${randomUUID()}.webp`;
  repository.enqueueDeletion(objectKey, requestedAt);
  mediaStore.objects.set(objectKey, Buffer.from('normalized'));
  mediaStore.failDelete = true;
  const summary = await new ChatMediaCleanupService(repository, mediaStore, clock).runOnce();
  assert.equal(summary.pendingDeletionJobs, 1);
  assert.equal(summary.dueDeletionJobs, 0);
  assert.equal(summary.oldestDeletionRequestedAt, requestedAt.toISOString());
  assert.equal(summary.oldestDeletionAgeMs, clock.now().getTime() - requestedAt.getTime());
  assert.equal(summary.oldestDeletionAgeMs! > 24 * 60 * 60 * 1000, true);
});

const createPhotoService = (
  repository: InMemoryChatRepository,
  mediaStore: FakeChatMediaStore,
  imageProcessor: FakeChatImageProcessor,
  clock: FixedChatClock,
): ChatService =>
  new ChatService({
    repository,
    eventPublisher: { publish: async () => undefined },
    rateLimiter: new NoopChatRateLimiter(),
    imageProcessor,
    mediaStore,
    clock,
    enabled: true,
    photoUploadsEnabled: true,
    mediaUrlTtlSeconds: 300,
    cursorSecret: 'test-only-chat-cleanup-cursor-secret-with-32-bytes',
  });

test('completed cleanup cannot be followed by a late orphan PUT', async () => {
  const repository = new InMemoryChatRepository();
  const clock = new FixedChatClock(new Date('2026-08-23T10:00:00.000Z'));
  const mediaStore = new FakeChatMediaStore();
  const cleanup = new ChatMediaCleanupService(repository, mediaStore, clock);
  const baseProcessor = new FakeChatImageProcessor();
  const imageProcessor = new FakeChatImageProcessor();
  let deletedObjectKey = '';
  imageProcessor.normalize = async (input) => {
    const photo = repository.peekPhoto();
    assert.notEqual(photo, null);
    deletedObjectKey = photo!.objectKey;
    repository.deletePhotoForTest(photo!.id, clock.now());
    const summary = await cleanup.runOnce();
    assert.equal(summary.deletionsCompleted, 1);
    return baseProcessor.normalize(input);
  };
  const service = createPhotoService(repository, mediaStore, imageProcessor, clock);
  const sessionId = randomUUID();
  repository.addSession(repository.clientId, sessionId);
  const conversation = await repository.createOrGetConversation(repository.clientId, clock.now());
  assert.notEqual(conversation, null);
  const context = { userId: repository.clientId, sessionId, ip: '127.0.0.1' };
  await service.preflightPhotoUpload(context);
  await assert.rejects(
    service.uploadPhotoAfterPreflight(
      context,
      conversation!.conversation.id,
      randomUUID(),
      Buffer.from('valid-photo'),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === 'CHAT_PHOTO_STORAGE_UNAVAILABLE',
  );
  assert.equal(mediaStore.objects.size, 0);
  assert.equal(repository.deletionJob(deletedObjectKey)?.completed, true);
});

test('cleanup delete waits for the upload object lock and removes a failed finalize', async () => {
  const repository = new InMemoryChatRepository();
  const clock = new FixedChatClock(new Date('2026-08-23T10:00:00.000Z'));
  const mediaStore = new FakeChatMediaStore();
  const cleanup = new ChatMediaCleanupService(repository, mediaStore, clock);
  const originalPut = mediaStore.putObject.bind(mediaStore);
  let cleanupPromise: Promise<unknown> | null = null;
  let objectPresentWhileUploadLocked = false;
  mediaStore.putObject = async (key, body) => {
    await originalPut(key, body);
    const photo = repository.peekPhoto();
    assert.notEqual(photo, null);
    repository.deletePhotoForTest(photo!.id, clock.now());
    cleanupPromise = cleanup.runOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    objectPresentWhileUploadLocked = mediaStore.objects.has(key);
  };
  const service = createPhotoService(repository, mediaStore, new FakeChatImageProcessor(), clock);
  const sessionId = randomUUID();
  repository.addSession(repository.clientId, sessionId);
  const conversation = await repository.createOrGetConversation(repository.clientId, clock.now());
  assert.notEqual(conversation, null);
  const context = { userId: repository.clientId, sessionId, ip: '127.0.0.1' };
  await service.preflightPhotoUpload(context);
  await assert.rejects(
    service.uploadPhotoAfterPreflight(
      context,
      conversation!.conversation.id,
      randomUUID(),
      Buffer.from('valid-photo'),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === 'CHAT_PHOTO_STORAGE_UNAVAILABLE',
  );
  assert.notEqual(cleanupPromise, null);
  await cleanupPromise;
  assert.equal(objectPresentWhileUploadLocked, true);
  assert.equal(mediaStore.objects.size, 0);
});
