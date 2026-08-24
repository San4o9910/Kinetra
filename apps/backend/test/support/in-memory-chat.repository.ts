import { randomUUID } from 'node:crypto';

import type {
  ChatActor,
  ChatConversationSnapshot,
  ChatMediaObjectLease,
  ChatMessageSnapshot,
  ChatPhotoSnapshot,
  ChatRepository,
  ConversationPage,
  CreateConversationResult,
  ListConversationsInput,
  ListMessagesInput,
  MediaDeletionBacklog,
  MediaDeletionJob,
  MessagePage,
  PhotoAccessSnapshot,
  ReadRepositoryInput,
  ReadRepositoryResult,
  ReadyPhotoInput,
  ReservePhotoInput,
  ReservePhotoResult,
  SendMessageRepositoryInput,
  SendMessageRepositoryResult,
  TrainerGrantInput,
  TrainerReassignInput,
} from '../../src/chat/repository.js';

const cloneDate = (value: Date): Date => new Date(value.getTime());

const clonePhoto = (photo: ChatPhotoSnapshot): ChatPhotoSnapshot => ({
  ...photo,
  expiresAt: cloneDate(photo.expiresAt),
  attachedAt: photo.attachedAt === null ? null : cloneDate(photo.attachedAt),
});

const cloneMessage = (message: ChatMessageSnapshot): ChatMessageSnapshot => ({
  ...message,
  photo: message.photo === null ? null : clonePhoto(message.photo),
  createdAt: cloneDate(message.createdAt),
});

const cloneConversation = (conversation: ChatConversationSnapshot): ChatConversationSnapshot => ({
  ...conversation,
  client: { ...conversation.client },
  trainer: { ...conversation.trainer },
  lastMessage: conversation.lastMessage === null ? null : cloneMessage(conversation.lastMessage),
  createdAt: cloneDate(conversation.createdAt),
  activityAt: cloneDate(conversation.activityAt),
});

interface DeletionJobState {
  requestedAt: Date;
  attemptCount: number;
  nextAttemptAt: Date;
  locked: boolean;
  completed: boolean;
}

export class InMemoryChatRepository implements ChatRepository {
  public readonly clientId: string;
  public readonly trainerId: string;
  private readonly actors = new Map<string, ChatActor>();
  private readonly sessions = new Set<string>();
  private readonly conversations = new Map<string, ChatConversationSnapshot>();
  private readonly messages = new Map<string, ChatMessageSnapshot[]>();
  private readonly photos = new Map<string, ChatPhotoSnapshot>();
  private readonly processingLeaseExpirations = new Map<string, Date>();
  private readonly uploadKeys = new Map<string, string>();
  private readonly deletionJobs = new Map<string, DeletionJobState>();
  private readonly mediaObjectLocks = new Map<string, Promise<void>>();
  private readonly conversationLocks = new Map<string, Promise<void>>();
  private defaultTrainerActive = true;

  public constructor(clientId = randomUUID(), trainerId = randomUUID()) {
    this.clientId = clientId;
    this.trainerId = trainerId;
    this.actors.set(clientId, {
      userId: clientId,
      role: 'client',
      onboardingStatus: 'active',
      displayName: 'Анна',
      avatarUrl: null,
    });
    this.actors.set(trainerId, {
      userId: trainerId,
      role: 'trainer',
      onboardingStatus: 'survey_pending',
      displayName: 'Тренер Kinetra',
      avatarUrl: null,
    });
  }

  public addActor(actor: ChatActor): void {
    this.actors.set(actor.userId, { ...actor });
  }

  public removeActor(userId: string): void {
    this.actors.delete(userId);
  }

  public addSession(userId: string, sessionId: string): void {
    this.sessions.add(`${userId}:${sessionId}`);
  }

  public revokeSession(userId: string, sessionId: string): void {
    this.sessions.delete(`${userId}:${sessionId}`);
  }

  public setDefaultTrainerActive(active: boolean): void {
    this.defaultTrainerActive = active;
  }

  public peekConversation(): ChatConversationSnapshot | null {
    const conversation = this.conversations.values().next().value as
      ChatConversationSnapshot | undefined;
    return conversation === undefined ? null : cloneConversation(conversation);
  }

  public peekConversationById(conversationId: string): ChatConversationSnapshot | null {
    const conversation = this.conversations.get(conversationId);
    return conversation === undefined ? null : cloneConversation(conversation);
  }

  public peekPhoto(): ChatPhotoSnapshot | null {
    const photo = this.photos.values().next().value as ChatPhotoSnapshot | undefined;
    return photo === undefined ? null : clonePhoto(photo);
  }

  public deletePhotoForTest(photoId: string, now: Date): void {
    const photo = this.photos.get(photoId);

    if (photo !== undefined) {
      this.photos.delete(photoId);
      this.processingLeaseExpirations.delete(photoId);
      this.enqueueDeletion(photo.objectKey, now);
    }
  }

  public enqueueDeletion(objectKey: string, now: Date): void {
    this.deletionJobs.set(objectKey, {
      requestedAt: cloneDate(now),
      attemptCount: 0,
      nextAttemptAt: cloneDate(now),
      locked: false,
      completed: false,
    });
  }

  public deletionJob(objectKey: string): DeletionJobState | null {
    const job = this.deletionJobs.get(objectKey);
    return job === undefined
      ? null
      : {
          ...job,
          requestedAt: cloneDate(job.requestedAt),
          nextAttemptAt: cloneDate(job.nextAttemptAt),
        };
  }

  public async withMediaObjectLock<T>(
    objectKey: string,
    operation: (lease: ChatMediaObjectLease) => Promise<T>,
  ): Promise<T> {
    return this.withLocalLock(this.mediaObjectLocks, objectKey, () =>
      operation({
        findPhotoStatus: (photoId, uploaderUserId) => this.findPhotoStatus(photoId, uploaderUserId),
        markPhotoReady: (input) => this.markPhotoReady(input),
        completeMediaDeletion: (key, now) => this.completeMediaDeletion(key, now),
      }),
    );
  }

  public async getRealtimeConversation(
    conversationId: string,
  ): Promise<ChatConversationSnapshot | null> {
    const conversation = this.conversations.get(conversationId);

    if (conversation === undefined) {
      return null;
    }

    const client = this.actors.get(conversation.client.userId);
    const trainer = this.actors.get(conversation.trainer.userId);
    return client?.role === 'client' &&
      client.onboardingStatus === 'active' &&
      trainer?.role === 'trainer'
      ? cloneConversation(conversation)
      : null;
  }

  public async findRealtimeRecipientConversation(
    userId: string,
    role: 'client' | 'trainer',
    conversationId: string,
  ): Promise<ChatConversationSnapshot | null> {
    const conversation = await this.getRealtimeConversation(conversationId);

    if (conversation === null) {
      return null;
    }

    const participant = role === 'client' ? conversation.client : conversation.trainer;
    return participant.userId === userId ? conversation : null;
  }

  private async withLocalLock<T>(
    locks: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    locks.set(key, current);
    await previous;

    try {
      return await operation();
    } finally {
      releaseCurrent();

      if (locks.get(key) === current) {
        locks.delete(key);
      }
    }
  }

  public async findActor(userId: string): Promise<ChatActor | null> {
    const actor = this.actors.get(userId);
    return actor === undefined ? null : { ...actor };
  }

  public async isSessionActive(userId: string, sessionId: string, _now: Date): Promise<boolean> {
    return this.sessions.has(`${userId}:${sessionId}`);
  }

  public async findConversationForClient(userId: string): Promise<ChatConversationSnapshot | null> {
    const conversation = [...this.conversations.values()].find(
      (candidate) => candidate.client.userId === userId,
    );
    return conversation === undefined ? null : cloneConversation(conversation);
  }

  public async hasActiveDefaultTrainer(): Promise<boolean> {
    return this.defaultTrainerActive;
  }

  public async countTrainerUnread(userId: string): Promise<number> {
    return [...this.conversations.values()]
      .filter((conversation) => conversation.trainer.userId === userId)
      .reduce((sum, conversation) => sum + conversation.trainerUnreadCount, 0);
  }

  public async createOrGetConversation(
    clientUserId: string,
    now: Date,
  ): Promise<CreateConversationResult | null> {
    const existingSnapshot = [...this.conversations.values()].find(
      (candidate) => candidate.client.userId === clientUserId,
    );
    const existing = existingSnapshot === undefined ? null : cloneConversation(existingSnapshot);

    if (existing !== null) {
      return { created: false, conversation: existing };
    }

    const client = this.actors.get(clientUserId);
    const trainer = this.actors.get(this.trainerId);

    if (
      client?.role !== 'client' ||
      client.onboardingStatus !== 'active' ||
      trainer?.role !== 'trainer' ||
      !this.defaultTrainerActive
    ) {
      return null;
    }

    const conversation: ChatConversationSnapshot = {
      id: randomUUID(),
      client: {
        userId: client.userId,
        displayName: client.displayName,
        secondaryLabel: 'a***@example.com',
        avatarUrl: client.avatarUrl,
      },
      trainer: {
        userId: trainer.userId,
        displayName: trainer.displayName,
        secondaryLabel: trainer.displayName,
        avatarUrl: trainer.avatarUrl,
      },
      lastMessage: null,
      lastMessageSequence: 0,
      clientLastReadSequence: 0,
      trainerLastReadSequence: 0,
      clientUnreadCount: 0,
      trainerUnreadCount: 0,
      createdAt: cloneDate(now),
      activityAt: cloneDate(now),
    };
    this.conversations.set(conversation.id, conversation);
    this.messages.set(conversation.id, []);
    return { created: true, conversation: cloneConversation(conversation) };
  }

  public async listTrainerConversations(input: ListConversationsInput): Promise<ConversationPage> {
    const query = input.query?.toLocaleLowerCase('ru-RU') ?? null;
    let values = [...this.conversations.values()]
      .filter((conversation) => conversation.trainer.userId === input.trainerUserId)
      .filter((conversation) => input.filter === 'all' || conversation.trainerUnreadCount > 0)
      .filter(
        (conversation) =>
          query === null ||
          conversation.client.displayName.toLocaleLowerCase('ru-RU').includes(query) ||
          conversation.client.secondaryLabel.toLocaleLowerCase('ru-RU').includes(query),
      )
      .sort(
        (left, right) =>
          right.activityAt.getTime() - left.activityAt.getTime() || right.id.localeCompare(left.id),
      );

    if (input.cursor !== null) {
      values = values.filter(
        (conversation) =>
          conversation.activityAt.getTime() < input.cursor!.activityAt.getTime() ||
          (conversation.activityAt.getTime() === input.cursor!.activityAt.getTime() &&
            conversation.id < input.cursor!.conversationId),
      );
    }

    return {
      items: values.slice(0, input.limit).map(cloneConversation),
      hasMore: values.length > input.limit,
    };
  }

  public async findTrainerConversation(
    trainerUserId: string,
    conversationId: string,
  ): Promise<ChatConversationSnapshot | null> {
    const conversation = this.conversations.get(conversationId);
    return conversation?.trainer.userId === trainerUserId ? cloneConversation(conversation) : null;
  }

  public async listMessages(input: ListMessagesInput): Promise<MessagePage | null> {
    const conversation = this.conversations.get(input.conversationId);

    if (
      conversation === undefined ||
      ![conversation.client.userId, conversation.trainer.userId].includes(input.userId)
    ) {
      return null;
    }

    let values = this.messages.get(input.conversationId) ?? [];

    if (input.beforeSequence !== null) {
      values = values.filter((message) => message.sequence < input.beforeSequence!);
    }

    if (input.afterSequence !== null) {
      values = values.filter((message) => message.sequence > input.afterSequence!);
    }

    const latest = input.beforeSequence === null && input.afterSequence === null;
    const selected = latest
      ? values.slice(Math.max(0, values.length - input.limit))
      : values.slice(0, input.limit);
    return {
      conversation: cloneConversation(conversation),
      messages: selected.map(cloneMessage),
      hasMoreBefore: latest
        ? values.length > selected.length
        : input.beforeSequence !== null && values.length > selected.length,
      hasMoreAfter: input.afterSequence !== null && values.length > selected.length,
    };
  }

  public async sendMessage(
    input: SendMessageRepositoryInput,
  ): Promise<SendMessageRepositoryResult> {
    const conversation = this.conversations.get(input.conversationId);

    if (
      conversation === undefined ||
      ![conversation.client.userId, conversation.trainer.userId].includes(input.userId)
    ) {
      return { kind: 'not_found' };
    }

    const actor = this.actors.get(input.userId);

    if (actor === undefined || (actor.role === 'client' && actor.onboardingStatus !== 'active')) {
      return { kind: 'not_available' };
    }

    const existing = (this.messages.get(conversation.id) ?? []).find(
      (message) =>
        message.senderUserId === input.userId && message.clientMessageId === input.clientMessageId,
    );

    if (existing !== undefined) {
      return existing.requestFingerprint === input.requestFingerprint
        ? {
            kind: 'replay',
            conversation: cloneConversation(conversation),
            message: cloneMessage(existing),
          }
        : { kind: 'idempotency_conflict' };
    }

    let photo: ChatPhotoSnapshot | null = null;

    if (input.photoId !== null) {
      const candidate = this.photos.get(input.photoId);

      if (
        candidate === undefined ||
        candidate.conversationId !== conversation.id ||
        candidate.uploaderUserId !== input.userId ||
        candidate.status !== 'ready' ||
        candidate.expiresAt.getTime() <= input.now.getTime()
      ) {
        return candidate?.status === 'attached'
          ? { kind: 'photo_already_attached' }
          : { kind: 'photo_not_ready' };
      }

      photo = { ...candidate, status: 'attached', attachedAt: cloneDate(input.now) };
      this.photos.set(photo.id, photo);
      this.processingLeaseExpirations.delete(photo.id);
    }

    const role = conversation.client.userId === input.userId ? 'client' : 'trainer';
    const message: ChatMessageSnapshot = {
      id: randomUUID(),
      conversationId: conversation.id,
      sequence: conversation.lastMessageSequence + 1,
      senderUserId: input.userId,
      senderRole: role,
      senderName: actor.displayName,
      clientMessageId: input.clientMessageId,
      requestFingerprint: input.requestFingerprint,
      kind: input.kind,
      body: input.body,
      photo,
      createdAt: cloneDate(input.now),
    };
    const nextConversation: ChatConversationSnapshot = {
      ...conversation,
      lastMessage: message,
      lastMessageSequence: message.sequence,
      clientUnreadCount:
        role === 'trainer' ? conversation.clientUnreadCount + 1 : conversation.clientUnreadCount,
      trainerUnreadCount:
        role === 'client' ? conversation.trainerUnreadCount + 1 : conversation.trainerUnreadCount,
      activityAt: cloneDate(input.now),
    };
    this.messages.set(conversation.id, [...(this.messages.get(conversation.id) ?? []), message]);
    this.conversations.set(conversation.id, nextConversation);
    return {
      kind: 'created',
      conversation: cloneConversation(nextConversation),
      message: cloneMessage(message),
    };
  }

  public async markRead(input: ReadRepositoryInput): Promise<ReadRepositoryResult> {
    const conversation = this.conversations.get(input.conversationId);

    if (
      conversation === undefined ||
      ![conversation.client.userId, conversation.trainer.userId].includes(input.userId)
    ) {
      return { kind: 'not_found' };
    }

    if (input.throughSequence > conversation.lastMessageSequence) {
      return { kind: 'future_cursor' };
    }

    const role = conversation.client.userId === input.userId ? 'client' : 'trainer';
    const old =
      role === 'client'
        ? conversation.clientLastReadSequence
        : conversation.trainerLastReadSequence;
    const through = Math.max(old, input.throughSequence);
    const unread = (this.messages.get(conversation.id) ?? []).filter(
      (message) => message.senderRole !== role && message.sequence > through,
    ).length;
    const next: ChatConversationSnapshot =
      role === 'client'
        ? {
            ...conversation,
            clientLastReadSequence: through,
            clientUnreadCount: unread,
          }
        : {
            ...conversation,
            trainerLastReadSequence: through,
            trainerUnreadCount: unread,
          };
    this.conversations.set(conversation.id, next);
    return {
      kind: through > old ? 'updated' : 'unchanged',
      conversation: cloneConversation(next),
      readerRole: role,
    };
  }

  public async reservePhoto(input: ReservePhotoInput): Promise<ReservePhotoResult> {
    const conversation = this.conversations.get(input.conversationId);

    if (
      conversation === undefined ||
      ![conversation.client.userId, conversation.trainer.userId].includes(input.uploaderUserId)
    ) {
      return { kind: 'not_found' };
    }

    const uploadKey = `${input.uploaderUserId}:${input.clientUploadId}`;
    const existingId = this.uploadKeys.get(uploadKey);
    const existing = existingId === undefined ? undefined : this.photos.get(existingId);

    if (existing !== undefined) {
      const storedHash = (existing as ChatPhotoSnapshot & { readonly inputSha256?: string })
        .inputSha256;

      if (storedHash !== input.inputSha256 || existing.conversationId !== input.conversationId) {
        return { kind: 'idempotency_conflict' };
      }

      if (existing.status === 'ready' || existing.status === 'attached') {
        return { kind: existing.status, photo: clonePhoto(existing) };
      }

      if (
        existing.status === 'processing' &&
        (this.processingLeaseExpirations.get(existing.id)?.getTime() ?? 0) > input.now.getTime()
      ) {
        return { kind: 'processing', photo: clonePhoto(existing) };
      }

      if (existing.attemptCount >= 3) {
        return { kind: 'retry_exhausted' };
      }

      const retried = {
        ...existing,
        status: 'processing' as const,
        expiresAt: cloneDate(input.expiresAt),
        attemptCount: existing.attemptCount + 1,
        lastErrorCode: null,
        attachedAt: null,
      };
      this.photos.set(existing.id, retried);
      this.processingLeaseExpirations.set(existing.id, cloneDate(input.leaseExpiresAt));
      return { kind: 'reserved', photo: clonePhoto(retried) };
    }

    const photo: ChatPhotoSnapshot & { readonly inputSha256: string } = {
      id: input.id,
      conversationId: input.conversationId,
      uploaderUserId: input.uploaderUserId,
      clientUploadId: input.clientUploadId,
      inputSha256: input.inputSha256,
      objectKey: input.objectKey,
      status: 'processing',
      mimeType: 'image/webp',
      sizeBytes: 1,
      width: 1,
      height: 1,
      expiresAt: cloneDate(input.expiresAt),
      attemptCount: 1,
      lastErrorCode: null,
      attachedAt: null,
    };
    this.photos.set(photo.id, photo);
    this.processingLeaseExpirations.set(photo.id, cloneDate(input.leaseExpiresAt));
    this.uploadKeys.set(uploadKey, photo.id);
    return { kind: 'reserved', photo: clonePhoto(photo) };
  }

  public async markPhotoReady(input: ReadyPhotoInput): Promise<ChatPhotoSnapshot | null> {
    const photo = this.photos.get(input.photoId);
    const conversation =
      photo === undefined ? undefined : this.conversations.get(photo.conversationId);

    if (
      photo === undefined ||
      conversation === undefined ||
      photo.uploaderUserId !== input.uploaderUserId ||
      photo.status !== 'processing' ||
      ![conversation.client.userId, conversation.trainer.userId].includes(input.uploaderUserId)
    ) {
      return null;
    }

    const ready: ChatPhotoSnapshot = {
      ...photo,
      status: 'ready',
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      width: input.width,
      height: input.height,
      lastErrorCode: null,
    };
    this.photos.set(photo.id, ready);
    this.processingLeaseExpirations.delete(photo.id);
    return clonePhoto(ready);
  }

  public async markPhotoFailed(
    photoId: string,
    uploaderUserId: string,
    errorCode: string,
    _now: Date,
  ): Promise<void> {
    const photo = this.photos.get(photoId);
    const conversation =
      photo === undefined ? undefined : this.conversations.get(photo.conversationId);

    if (
      photo?.uploaderUserId === uploaderUserId &&
      photo.status === 'processing' &&
      conversation !== undefined &&
      [conversation.client.userId, conversation.trainer.userId].includes(uploaderUserId)
    ) {
      this.photos.set(photoId, { ...photo, status: 'failed', lastErrorCode: errorCode });
      this.processingLeaseExpirations.delete(photoId);
    }
  }

  public async findPhotoStatus(
    photoId: string,
    uploaderUserId: string,
  ): Promise<ChatPhotoSnapshot | null> {
    const photo = this.photos.get(photoId);
    const conversation =
      photo === undefined ? undefined : this.conversations.get(photo.conversationId);
    return photo?.uploaderUserId === uploaderUserId &&
      conversation !== undefined &&
      [conversation.client.userId, conversation.trainer.userId].includes(uploaderUserId)
      ? clonePhoto(photo)
      : null;
  }

  public async findPhotoAccess(
    photoId: string,
    userId: string,
    now: Date,
  ): Promise<PhotoAccessSnapshot | null> {
    const photo = this.photos.get(photoId);
    const conversation =
      photo === undefined ? undefined : this.conversations.get(photo.conversationId);

    if (
      photo === undefined ||
      conversation === undefined ||
      photo.status === 'failed' ||
      ![conversation.client.userId, conversation.trainer.userId].includes(userId)
    ) {
      return null;
    }

    const draftAccess =
      ['processing', 'ready'].includes(photo.status) &&
      photo.uploaderUserId === userId &&
      photo.expiresAt.getTime() > now.getTime();
    const attachedAccess =
      photo.status === 'attached' &&
      [conversation.client.userId, conversation.trainer.userId].includes(userId);
    return draftAccess || attachedAccess ? { photo: clonePhoto(photo), canAccess: true } : null;
  }

  public async expireStalePhotos(now: Date, limit: number): Promise<number> {
    const stale = [...this.photos.values()]
      .filter(
        (photo) =>
          photo.status !== 'attached' &&
          (photo.status === 'processing'
            ? (this.processingLeaseExpirations.get(photo.id)?.getTime() ?? 0) <= now.getTime()
            : photo.expiresAt.getTime() <= now.getTime()),
      )
      .slice(0, limit);

    for (const photo of stale) {
      this.photos.delete(photo.id);
      this.processingLeaseExpirations.delete(photo.id);
      this.enqueueDeletion(photo.objectKey, now);
    }

    return stale.length;
  }

  public async claimMediaDeletionJobs(
    now: Date,
    limit: number,
  ): Promise<readonly MediaDeletionJob[]> {
    const jobs: MediaDeletionJob[] = [];

    for (const [objectKey, job] of this.deletionJobs) {
      if (
        jobs.length >= limit ||
        job.completed ||
        job.locked ||
        job.nextAttemptAt.getTime() > now.getTime()
      ) {
        continue;
      }

      job.locked = true;
      job.attemptCount += 1;
      jobs.push({ objectKey, attemptCount: job.attemptCount });
    }

    return jobs;
  }

  public async getMediaDeletionBacklog(now: Date): Promise<MediaDeletionBacklog> {
    const pending = [...this.deletionJobs.values()].filter((job) => !job.completed);
    const oldest = pending.reduce<Date | null>(
      (value, job) =>
        value === null || job.requestedAt.getTime() < value.getTime() ? job.requestedAt : value,
      null,
    );
    return {
      pendingCount: pending.length,
      dueCount: pending.filter((job) => job.nextAttemptAt.getTime() <= now.getTime()).length,
      oldestRequestedAt: oldest === null ? null : cloneDate(oldest),
    };
  }

  public async completeMediaDeletion(objectKey: string, _now: Date): Promise<void> {
    const job = this.deletionJobs.get(objectKey);

    if (job !== undefined) {
      job.completed = true;
      job.locked = false;
    }
  }

  public async retryMediaDeletion(
    objectKey: string,
    _errorCode: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    const job = this.deletionJobs.get(objectKey);

    if (job !== undefined) {
      job.nextAttemptAt = cloneDate(nextAttemptAt);
      job.locked = false;
    }
  }

  public async grantTrainer(
    input: TrainerGrantInput,
  ): Promise<'granted' | 'user_not_found' | 'email_not_verified' | 'client_conversation'> {
    return this.actors.has(input.userId) ? 'granted' : 'user_not_found';
  }

  public async reassignTrainer(input: TrainerReassignInput): Promise<number | null> {
    let count = 0;
    const target = this.actors.get(input.toTrainerUserId);

    if (target?.role !== 'trainer' || input.fromTrainerUserId === input.toTrainerUserId) {
      return null;
    }

    for (const [id, initialConversation] of this.conversations) {
      if (
        initialConversation.trainer.userId === input.fromTrainerUserId &&
        (input.conversationIds === null || input.conversationIds.includes(id))
      ) {
        await this.withLocalLock(this.conversationLocks, id, async () => {
          const conversation = this.conversations.get(id);

          if (conversation?.trainer.userId !== input.fromTrainerUserId) {
            return;
          }

          for (const photo of this.photos.values()) {
            if (
              photo.conversationId === id &&
              photo.uploaderUserId === input.fromTrainerUserId &&
              photo.status !== 'attached'
            ) {
              this.photos.delete(photo.id);
              this.processingLeaseExpirations.delete(photo.id);
              this.enqueueDeletion(photo.objectKey, input.now);
            }
          }

          this.conversations.set(id, {
            ...conversation,
            trainer: {
              userId: target.userId,
              displayName: target.displayName,
              secondaryLabel: target.displayName,
              avatarUrl: target.avatarUrl,
            },
          });
          count += 1;
        });
      }
    }

    return count;
  }

  public async revokeTrainer(
    userId: string,
    _now: Date,
  ): Promise<'revoked' | 'not_found' | 'assigned' | 'default'> {
    if (!this.actors.has(userId)) {
      return 'not_found';
    }

    if ([...this.conversations.values()].some((value) => value.trainer.userId === userId)) {
      return 'assigned';
    }

    return 'revoked';
  }
}
