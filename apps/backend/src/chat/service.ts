import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { HttpError } from '../auth/errors.js';
import type { Clock } from '../auth/service.js';
import type { ChatDomainEvent, ChatEventPublisher } from './event-hub.js';
import { ChatMediaError, type ChatImageProcessor, type ChatMediaStore } from './media.js';
import type { ChatRateLimiter } from './rate-limit.js';
import type {
  ChatActor,
  ChatConversationSnapshot,
  ChatMessageSnapshot,
  ChatParticipant,
  ChatPhotoSnapshot,
  ChatRepository,
  ChatRole,
} from './repository.js';
import {
  canonicalizeChatText,
  parseCursorPayload,
  type ConversationListQuery,
  type MessageListQuery,
  type SendMessageInput,
} from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

export interface ChatPhotoDto {
  readonly id: string;
  readonly status: ChatPhotoSnapshot['status'];
  readonly mime_type: 'image/webp';
  readonly width: number;
  readonly height: number;
  readonly size_bytes: number;
  readonly expires_at: string | null;
  readonly failure_code?: string;
  readonly retry_allowed?: boolean;
}

export interface ChatMessageDto {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: number;
  readonly client_message_id: string;
  readonly sender_role: ChatRole;
  readonly is_mine: boolean;
  readonly sender_name: string;
  readonly kind: 'text' | 'photo';
  readonly text: string | null;
  readonly photo: ChatPhotoDto | null;
  readonly created_at: string;
}

export interface ChatConversationStateDto {
  readonly last_message_sequence: number;
  readonly own_last_read_sequence: number;
  readonly counterpart_last_read_sequence: number;
  readonly unread_count: number;
}

export interface ChatConversationSummaryDto {
  readonly id: string;
  readonly client: {
    readonly display_name: string;
    readonly secondary_label: string;
    readonly avatar_url: string | null;
  };
  readonly last_message: {
    readonly kind: 'text' | 'photo';
    readonly preview: string;
    readonly created_at: string;
  } | null;
  readonly unread_count: number;
  readonly activity_at: string;
}

export type ChatSessionDto =
  | {
      readonly role: 'client';
      readonly enabled: true;
      readonly photo_uploads_enabled: boolean;
      readonly available: boolean;
      readonly conversation: {
        readonly id: string;
        readonly trainer: {
          readonly display_name: string;
          readonly avatar_url: string | null;
        };
        readonly last_message_sequence: number;
        readonly last_read_sequence: number;
        readonly counterpart_last_read_sequence: number;
        readonly unread_count: number;
      } | null;
    }
  | {
      readonly role: 'trainer';
      readonly enabled: true;
      readonly photo_uploads_enabled: boolean;
      readonly profile: {
        readonly display_name: string;
        readonly avatar_url: string | null;
      };
      readonly unread_count: number;
    };

export interface ChatServiceOptions {
  readonly repository: ChatRepository;
  readonly eventPublisher: ChatEventPublisher;
  readonly rateLimiter: ChatRateLimiter;
  readonly imageProcessor: ChatImageProcessor;
  readonly mediaStore: ChatMediaStore;
  readonly clock: Clock;
  readonly enabled: boolean;
  readonly photoUploadsEnabled: boolean;
  readonly mediaUrlTtlSeconds: number;
  readonly cursorSecret: string;
}

export interface ChatRequestContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly ip: string;
}

export interface MessagePageDto {
  readonly messages: readonly ChatMessageDto[];
  readonly conversation_state: ChatConversationStateDto;
  readonly next_before_sequence: number | null;
  readonly has_more_before: boolean;
  readonly next_after_sequence: number | null;
  readonly has_more_after: boolean;
}

export interface PhotoUploadResult {
  readonly statusCode: 200 | 201 | 202;
  readonly photo: ChatPhotoDto;
}

class PhotoUploadAdmission {
  public streamedBytes = 0;
  public claimedByUpload = false;

  public constructor(
    public readonly service: ChatService,
    public readonly userId: string,
  ) {}
}

const resourceNotFound = (): HttpError =>
  new HttpError(404, 'CHAT_RESOURCE_NOT_FOUND', 'The chat resource was not found.');

const safeParticipant = (participant: ChatParticipant) => ({
  display_name: participant.displayName,
  secondary_label: participant.secondaryLabel,
  avatar_url: participant.avatarUrl,
});

const toPhotoDto = (photo: ChatPhotoSnapshot): ChatPhotoDto => ({
  id: photo.id,
  status: photo.status,
  mime_type: photo.mimeType,
  width: photo.width,
  height: photo.height,
  size_bytes: photo.sizeBytes,
  expires_at: photo.status === 'attached' ? null : photo.expiresAt.toISOString(),
  ...(photo.status === 'failed' && photo.lastErrorCode !== null
    ? {
        failure_code: photo.lastErrorCode,
        retry_allowed: photo.attemptCount < 3,
      }
    : {}),
});

export const projectMessageFor = (
  message: ChatMessageSnapshot,
  recipientUserId: string,
): ChatMessageDto => ({
  id: message.id,
  conversation_id: message.conversationId,
  sequence: message.sequence,
  client_message_id: message.clientMessageId,
  sender_role: message.senderRole,
  is_mine: message.senderUserId === recipientUserId,
  sender_name: message.senderName,
  kind: message.kind,
  text: message.body,
  photo: message.photo === null ? null : toPhotoDto(message.photo),
  created_at: message.createdAt.toISOString(),
});

export const conversationUnreadFor = (
  conversation: ChatConversationSnapshot,
  role: ChatRole,
): number => (role === 'client' ? conversation.clientUnreadCount : conversation.trainerUnreadCount);

const conversationStateFor = (
  conversation: ChatConversationSnapshot,
  role: ChatRole,
): ChatConversationStateDto => ({
  last_message_sequence: conversation.lastMessageSequence,
  own_last_read_sequence:
    role === 'client' ? conversation.clientLastReadSequence : conversation.trainerLastReadSequence,
  counterpart_last_read_sequence:
    role === 'client' ? conversation.trainerLastReadSequence : conversation.clientLastReadSequence,
  unread_count: conversationUnreadFor(conversation, role),
});

export const trainerConversationSummary = (
  conversation: ChatConversationSnapshot,
): ChatConversationSummaryDto => ({
  id: conversation.id,
  client: safeParticipant(conversation.client),
  last_message:
    conversation.lastMessage === null
      ? null
      : {
          kind: conversation.lastMessage.kind,
          preview:
            conversation.lastMessage.kind === 'photo'
              ? '📷 Фото'
              : (conversation.lastMessage.body ?? ''),
          created_at: conversation.lastMessage.createdAt.toISOString(),
        },
  unread_count: conversation.trainerUnreadCount,
  activity_at: conversation.activityAt.toISOString(),
});

const actorRoleInConversation = (
  actor: ChatActor,
  conversation: ChatConversationSnapshot,
): ChatRole => (actor.userId === conversation.client.userId ? 'client' : 'trainer');

export class ChatService {
  private readonly repository: ChatRepository;
  private readonly eventPublisher: ChatEventPublisher;
  private readonly rateLimiter: ChatRateLimiter;
  private readonly imageProcessor: ChatImageProcessor;
  private readonly mediaStore: ChatMediaStore;
  private readonly clock: Clock;
  private readonly enabled: boolean;
  private readonly photoUploadsEnabled: boolean;
  private readonly mediaUrlTtlSeconds: number;
  private readonly cursorSecret: string;

  public constructor(options: ChatServiceOptions) {
    this.repository = options.repository;
    this.eventPublisher = options.eventPublisher;
    this.rateLimiter = options.rateLimiter;
    this.imageProcessor = options.imageProcessor;
    this.mediaStore = options.mediaStore;
    this.clock = options.clock;
    this.enabled = options.enabled;
    this.photoUploadsEnabled = options.photoUploadsEnabled;
    this.mediaUrlTtlSeconds = options.mediaUrlTtlSeconds;
    this.cursorSecret = options.cursorSecret;
  }

  public async isSessionActive(userId: string, sessionId: string): Promise<boolean> {
    return this.repository.isSessionActive(userId, sessionId, this.clock.now());
  }

  public async getSocketActor(userId: string, sessionId: string): Promise<ChatActor | null> {
    if (!this.enabled || !(await this.isSessionActive(userId, sessionId))) {
      return null;
    }

    const actor = await this.repository.findActor(userId);
    return actor === null || (actor.role === 'client' && actor.onboardingStatus !== 'active')
      ? null
      : actor;
  }

  public async validateSocketIdentity(
    userId: string,
    sessionId: string,
    expectedRole: ChatRole,
  ): Promise<'active' | 'session_inactive' | 'account_changed'> {
    if (!(await this.isSessionActive(userId, sessionId))) {
      return 'session_inactive';
    }

    const actor = await this.repository.findActor(userId);
    return this.enabled &&
      actor !== null &&
      actor.role === expectedRole &&
      (actor.role === 'trainer' || actor.onboardingStatus === 'active')
      ? 'active'
      : 'account_changed';
  }

  public async withRealtimeConversation<T>(
    conversationId: string,
    operation: (conversation: ChatConversationSnapshot | null) => Promise<T>,
  ): Promise<T> {
    return this.repository.withCurrentConversation(conversationId, operation);
  }

  public async getSession(context: ChatRequestContext): Promise<ChatSessionDto> {
    const actor = await this.requireActor(context);

    if (actor.role === 'trainer') {
      return {
        role: 'trainer',
        enabled: true,
        photo_uploads_enabled: this.photoUploadsEnabled && this.mediaStore.available,
        profile: {
          display_name: actor.displayName,
          avatar_url: actor.avatarUrl,
        },
        unread_count: await this.repository.countTrainerUnread(actor.userId),
      };
    }

    const conversation = await this.repository.findConversationForClient(actor.userId);

    const available = conversation !== null || (await this.repository.hasActiveDefaultTrainer());

    return {
      role: 'client',
      enabled: true,
      photo_uploads_enabled: this.photoUploadsEnabled && this.mediaStore.available,
      available,
      conversation:
        conversation === null
          ? null
          : {
              id: conversation.id,
              trainer: {
                display_name: conversation.trainer.displayName,
                avatar_url: conversation.trainer.avatarUrl,
              },
              last_message_sequence: conversation.lastMessageSequence,
              last_read_sequence: conversation.clientLastReadSequence,
              counterpart_last_read_sequence: conversation.trainerLastReadSequence,
              unread_count: conversation.clientUnreadCount,
            },
    };
  }

  public async createConversation(context: ChatRequestContext): Promise<{
    readonly created: boolean;
    readonly conversation: NonNullable<Extract<ChatSessionDto, { role: 'client' }>['conversation']>;
  }> {
    const actor = await this.requireActor(context);

    if (actor.role !== 'client') {
      throw new HttpError(403, 'CHAT_NOT_AVAILABLE', 'This chat action is client-only.');
    }

    const result = await this.repository.createOrGetConversation(actor.userId, this.clock.now());

    if (result === null) {
      throw new HttpError(503, 'CHAT_TRAINER_UNAVAILABLE', 'A trainer is not available right now.');
    }

    if (result.created) {
      await this.publishSafely({
        kind: 'conversation_updated',
        conversation: result.conversation,
      });
    }

    return {
      created: result.created,
      conversation: {
        id: result.conversation.id,
        trainer: {
          display_name: result.conversation.trainer.displayName,
          avatar_url: result.conversation.trainer.avatarUrl,
        },
        last_message_sequence: result.conversation.lastMessageSequence,
        last_read_sequence: result.conversation.clientLastReadSequence,
        counterpart_last_read_sequence: result.conversation.trainerLastReadSequence,
        unread_count: result.conversation.clientUnreadCount,
      },
    };
  }

  public async listConversations(
    context: ChatRequestContext,
    query: ConversationListQuery,
  ): Promise<{
    readonly items: readonly ChatConversationSummaryDto[];
    readonly next_cursor: string | null;
  }> {
    const actor = await this.requireActor(context);

    if (actor.role !== 'trainer') {
      throw new HttpError(403, 'CHAT_NOT_AVAILABLE', 'Trainer access is required.');
    }

    this.consumeHistoryLimits(context);

    if (query.query !== null) {
      this.rateLimiter.consume({
        scope: 'trainer_search',
        key: `principal:${context.userId}`,
        maximum: 60,
        windowMs: 60_000,
      });
    }

    const cursor =
      query.cursor === undefined
        ? null
        : this.decodeCursor(query.cursor, query.filter, query.query);
    const page = await this.repository.listTrainerConversations({
      trainerUserId: actor.userId,
      filter: query.filter,
      query: query.query,
      cursor,
      limit: query.limit,
    });
    const last = page.items.at(-1);

    return {
      items: page.items.map(trainerConversationSummary),
      next_cursor:
        page.hasMore && last !== undefined
          ? this.encodeCursor(last, query.filter, query.query)
          : null,
    };
  }

  public async getConversationSummary(
    context: ChatRequestContext,
    conversationId: string,
  ): Promise<ChatConversationSummaryDto> {
    const actor = await this.requireActor(context);

    if (actor.role !== 'trainer') {
      throw new HttpError(403, 'CHAT_NOT_AVAILABLE', 'Trainer access is required.');
    }

    this.consumeHistoryLimits(context);
    const conversation = await this.repository.findTrainerConversation(
      actor.userId,
      conversationId,
    );

    if (conversation === null) {
      throw resourceNotFound();
    }

    return trainerConversationSummary(conversation);
  }

  public async listMessages(
    context: ChatRequestContext,
    conversationId: string,
    query: MessageListQuery,
  ): Promise<MessagePageDto> {
    const actor = await this.requireActor(context);
    this.consumeHistoryLimits(context);
    const page = await this.repository.listMessages({
      userId: actor.userId,
      conversationId,
      beforeSequence: query.before_sequence ?? null,
      afterSequence: query.after_sequence ?? null,
      limit: query.limit ?? 30,
    });

    if (page === null) {
      throw resourceNotFound();
    }

    const role = actorRoleInConversation(actor, page.conversation);
    const first = page.messages[0];
    const last = page.messages.at(-1);

    return {
      messages: page.messages.map((message) => projectMessageFor(message, actor.userId)),
      conversation_state: conversationStateFor(page.conversation, role),
      next_before_sequence: page.hasMoreBefore && first !== undefined ? first.sequence : null,
      has_more_before: page.hasMoreBefore,
      next_after_sequence: page.hasMoreAfter && last !== undefined ? last.sequence : null,
      has_more_after: page.hasMoreAfter,
    };
  }

  public async authorizeSocketSync(
    context: ChatRequestContext,
    conversationId: string,
    lastSequence: number,
  ): Promise<void> {
    const actor = await this.requireSocketActor(context);
    this.consumeHistoryLimits(context);
    const page = await this.repository.listMessages({
      userId: actor.userId,
      conversationId,
      beforeSequence: null,
      afterSequence: lastSequence,
      limit: 1,
    });

    if (page === null) {
      throw resourceNotFound();
    }
  }

  public async sendMessage(
    context: ChatRequestContext,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<{
    readonly created: boolean;
    readonly message: ChatMessageDto;
    readonly conversationState: ChatConversationStateDto;
  }> {
    const actor = await this.requireActor(context);
    this.consumeMessageLimits(context);
    const body =
      input.kind === 'text'
        ? canonicalizeChatText(input.text, 2000, false)
        : canonicalizeChatText(input.text, 1000, true);
    const photoId = input.kind === 'photo' ? input.photo_id : null;
    const requestFingerprint = this.messageFingerprint(
      conversationId,
      actor.userId,
      input.kind,
      body,
      photoId,
    );
    const result = await this.repository.sendMessage({
      userId: actor.userId,
      conversationId,
      clientMessageId: input.client_message_id,
      requestFingerprint,
      kind: input.kind,
      body,
      photoId,
      now: this.clock.now(),
    });

    if (result.kind === 'not_found') {
      throw resourceNotFound();
    }

    if (result.kind === 'not_available') {
      throw new HttpError(403, 'CHAT_NOT_AVAILABLE', 'Chat is not available for this account.');
    }

    if (result.kind === 'idempotency_conflict') {
      throw new HttpError(
        409,
        'CHAT_IDEMPOTENCY_CONFLICT',
        'The message idempotency key was already used for another payload.',
      );
    }

    if (result.kind === 'photo_not_ready') {
      throw new HttpError(409, 'CHAT_PHOTO_NOT_READY', 'The photo is not ready to attach.');
    }

    if (result.kind === 'photo_already_attached') {
      throw new HttpError(
        409,
        'CHAT_PHOTO_ALREADY_ATTACHED',
        'The photo was already attached to a message.',
      );
    }

    if (result.kind === 'created') {
      await this.publishSafely({
        kind: 'message_created',
        conversation: result.conversation,
        message: result.message,
      });
    }

    return {
      created: result.kind === 'created',
      message: projectMessageFor(result.message, actor.userId),
      conversationState: conversationStateFor(
        result.conversation,
        actorRoleInConversation(actor, result.conversation),
      ),
    };
  }

  public async markRead(
    context: ChatRequestContext,
    conversationId: string,
    throughSequence: number,
  ): Promise<ChatConversationStateDto> {
    const actor = await this.requireActor(context);
    this.consumeHistoryLimits(context);
    const now = this.clock.now();
    const result = await this.repository.markRead({
      userId: actor.userId,
      conversationId,
      throughSequence,
      now,
    });

    if (result.kind === 'not_found') {
      throw resourceNotFound();
    }

    if (result.kind === 'future_cursor') {
      throw new HttpError(400, 'CHAT_INVALID_REQUEST', 'Read cursor is beyond chat history.');
    }

    if (result.kind === 'updated') {
      await this.publishSafely({
        kind: 'read_updated',
        conversation: result.conversation,
        readerRole: result.readerRole,
        throughSequence,
        readAt: now,
      });
    }

    return conversationStateFor(result.conversation, result.readerRole);
  }

  public async preflightPhotoUpload(context: ChatRequestContext): Promise<PhotoUploadAdmission> {
    const actor = await this.requireActor(context);
    this.assertPhotoUploadsAvailable();
    this.consumePhotoAttemptLimits(actor.userId);
    return new PhotoUploadAdmission(this, actor.userId);
  }

  public accountPhotoUploadBytes(admission: PhotoUploadAdmission, bytes: number): void {
    if (
      admission.service !== this ||
      admission.claimedByUpload ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0
    ) {
      throw new Error('Invalid photo upload byte-accounting admission.');
    }

    if (bytes === 0) {
      return;
    }

    const streamedBytes = admission.streamedBytes + bytes;

    if (!Number.isSafeInteger(streamedBytes)) {
      throw new Error('Photo upload byte accounting overflowed.');
    }

    admission.streamedBytes = streamedBytes;
    this.consumePhotoByteLimit(admission.userId, bytes);
  }

  public async uploadPhotoAfterPreflight(
    context: ChatRequestContext,
    conversationId: string,
    clientUploadId: string,
    input: Buffer,
    admission?: PhotoUploadAdmission,
  ): Promise<PhotoUploadResult> {
    const actor = await this.requireActor(context);
    this.assertPhotoUploadsAvailable();

    if (admission === undefined) {
      this.consumePhotoByteLimit(actor.userId, input.length);
    } else {
      if (
        admission.service !== this ||
        admission.userId !== actor.userId ||
        admission.claimedByUpload ||
        admission.streamedBytes < input.length
      ) {
        throw new Error('Invalid photo upload byte-accounting admission.');
      }

      admission.claimedByUpload = true;
    }

    const now = this.clock.now();
    const photoId = randomUUID();
    const result = await this.repository.reservePhoto({
      id: photoId,
      conversationId,
      uploaderUserId: actor.userId,
      clientUploadId,
      inputSha256: createHash('sha256').update(input).digest('hex'),
      objectKey: `chat/${photoId.slice(0, 2)}/${randomUUID()}.webp`,
      expiresAt: new Date(now.getTime() + DAY_MS),
      leaseExpiresAt: new Date(now.getTime() + PROCESSING_LEASE_MS),
      now,
    });

    if (result.kind === 'not_found') {
      throw resourceNotFound();
    }

    if (result.kind === 'idempotency_conflict') {
      throw new HttpError(
        409,
        'CHAT_UPLOAD_IDEMPOTENCY_CONFLICT',
        'The upload idempotency key was used with different bytes.',
      );
    }

    if (result.kind === 'retry_exhausted') {
      throw new HttpError(409, 'CHAT_PHOTO_RETRY_EXHAUSTED', 'Photo retry limit was reached.');
    }

    if (result.kind === 'processing') {
      return { statusCode: 202, photo: toPhotoDto(result.photo) };
    }

    if (result.kind === 'ready' || result.kind === 'attached') {
      return { statusCode: 200, photo: toPhotoDto(result.photo) };
    }

    let normalized;

    try {
      normalized = await this.imageProcessor.normalize(input);
    } catch (error) {
      const code = error instanceof ChatMediaError ? error.code : 'CHAT_PHOTO_INVALID';
      await this.repository.markPhotoFailed(result.photo.id, actor.userId, code, this.clock.now());
      throw error;
    }

    let ready: ChatPhotoSnapshot | null;

    try {
      ready = await this.repository.withMediaObjectLock(result.photo.objectKey, async (lease) => {
        const current = await lease.findPhotoStatus(result.photo.id, actor.userId);

        if (
          current === null ||
          current.status !== 'processing' ||
          current.objectKey !== result.photo.objectKey
        ) {
          return null;
        }

        await this.mediaStore.putObject(result.photo.objectKey, normalized.bytes);
        return lease.markPhotoReady({
          photoId: result.photo.id,
          uploaderUserId: actor.userId,
          mimeType: normalized.mimeType,
          sizeBytes: normalized.bytes.length,
          width: normalized.width,
          height: normalized.height,
          now: this.clock.now(),
        });
      });
    } catch {
      await this.repository.markPhotoFailed(
        result.photo.id,
        actor.userId,
        'CHAT_PHOTO_STORAGE_UNAVAILABLE',
        this.clock.now(),
      );
      throw new HttpError(
        503,
        'CHAT_PHOTO_STORAGE_UNAVAILABLE',
        'Photo storage is temporarily unavailable.',
      );
    }

    if (ready === null) {
      throw new HttpError(
        503,
        'CHAT_PHOTO_STORAGE_UNAVAILABLE',
        'Photo upload recovery is in progress.',
      );
    }

    return { statusCode: 201, photo: toPhotoDto(ready) };
  }

  public async getPhotoStatus(context: ChatRequestContext, photoId: string): Promise<ChatPhotoDto> {
    await this.requireActor(context);
    const photo = await this.repository.findPhotoStatus(photoId, context.userId);

    if (photo === null) {
      throw resourceNotFound();
    }

    return toPhotoDto(photo);
  }

  public async getPhotoAccess(
    context: ChatRequestContext,
    photoId: string,
  ): Promise<{ readonly url: string; readonly expires_at: string }> {
    await this.requireActor(context);
    this.assertPhotoStorageAvailable();
    const now = this.clock.now();
    const access = await this.repository.findPhotoAccess(photoId, context.userId, now);

    if (access === null || !access.canAccess) {
      throw resourceNotFound();
    }

    let url: string;

    try {
      url = await this.mediaStore.createSignedGet(access.photo.objectKey, this.mediaUrlTtlSeconds);
    } catch {
      throw new HttpError(
        503,
        'CHAT_PHOTO_STORAGE_UNAVAILABLE',
        'Photo storage is temporarily unavailable.',
      );
    }

    return {
      url,
      expires_at: new Date(now.getTime() + this.mediaUrlTtlSeconds * 1000).toISOString(),
    };
  }

  private async requireActor(context: ChatRequestContext): Promise<ChatActor> {
    if (!this.enabled) {
      throw new HttpError(503, 'CHAT_DISABLED', 'Chat is currently disabled.');
    }

    if (
      !(await this.repository.isSessionActive(context.userId, context.sessionId, this.clock.now()))
    ) {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'A valid access token is required.');
    }

    const actor = await this.repository.findActor(context.userId);

    if (actor === null) {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'A valid access token is required.');
    }

    if (actor.role === 'client' && actor.onboardingStatus !== 'active') {
      throw new HttpError(403, 'CHAT_NOT_AVAILABLE', 'Complete onboarding to use trainer chat.');
    }

    return actor;
  }

  private async requireSocketActor(context: ChatRequestContext): Promise<ChatActor> {
    if (!this.enabled) {
      throw new HttpError(503, 'CHAT_DISABLED', 'Chat is currently disabled.');
    }

    if (
      !(await this.repository.isSessionActive(context.userId, context.sessionId, this.clock.now()))
    ) {
      throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'A valid access token is required.');
    }

    const actor = await this.repository.findActor(context.userId);

    if (actor === null || (actor.role === 'client' && actor.onboardingStatus !== 'active')) {
      throw new HttpError(403, 'CHAT_NOT_AVAILABLE', 'Chat access changed for this account.');
    }

    return actor;
  }

  private assertPhotoUploadsAvailable(): void {
    if (!this.photoUploadsEnabled || !this.mediaStore.available) {
      throw new HttpError(
        503,
        'CHAT_PHOTO_STORAGE_UNAVAILABLE',
        'Photo upload is currently unavailable.',
      );
    }
  }

  private assertPhotoStorageAvailable(): void {
    if (!this.mediaStore.available) {
      throw new HttpError(
        503,
        'CHAT_PHOTO_STORAGE_UNAVAILABLE',
        'Photo storage is currently unavailable.',
      );
    }
  }

  private consumeHistoryLimits(context: ChatRequestContext): void {
    for (const key of [`principal:${context.userId}`, `ip:${context.ip}`]) {
      this.rateLimiter.consume({
        scope: 'history',
        key,
        maximum: 120,
        windowMs: 60_000,
      });
    }
  }

  private consumeMessageLimits(context: ChatRequestContext): void {
    for (const key of [`principal:${context.userId}`, `ip:${context.ip}`]) {
      this.rateLimiter.consume({
        scope: 'message',
        key,
        maximum: 30,
        windowMs: 60_000,
      });
    }
  }

  private consumePhotoAttemptLimits(userId: string): void {
    this.rateLimiter.consume({
      scope: 'photo_minute',
      key: `principal:${userId}`,
      maximum: 5,
      windowMs: 60_000,
    });
    this.rateLimiter.consume({
      scope: 'photo_hour',
      key: `principal:${userId}`,
      maximum: 20,
      windowMs: 60 * 60 * 1000,
    });
  }

  private consumePhotoByteLimit(userId: string, bytes: number): void {
    this.rateLimiter.consume({
      scope: 'photo_bytes_hour',
      key: `principal:${userId}`,
      maximum: 100 * 1024 * 1024,
      windowMs: 60 * 60 * 1000,
      cost: bytes,
    });
  }

  private messageFingerprint(
    conversationId: string,
    senderUserId: string,
    kind: 'text' | 'photo',
    canonicalText: string | null,
    photoId: string | null,
  ): string {
    const canonicalJson = JSON.stringify({
      version: 1,
      conversation_id: conversationId,
      sender_user_id: senderUserId,
      kind,
      canonical_text_or_null: canonicalText,
      photo_id_or_null: photoId,
    });
    return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  }

  private encodeCursor(
    conversation: ChatConversationSnapshot,
    filter: 'all' | 'unread',
    query: string | null,
  ): string {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        activity_at: conversation.activityAt.toISOString(),
        conversation_id: conversation.id,
        filter,
        query,
      }),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', this.cursorSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  private decodeCursor(
    cursor: string,
    filter: 'all' | 'unread',
    query: string | null,
  ): { readonly activityAt: Date; readonly conversationId: string } {
    const [payload, signature, extra] = cursor.split('.');

    if (payload === undefined || signature === undefined || extra !== undefined) {
      throw new HttpError(400, 'CHAT_INVALID_REQUEST', 'The chat cursor is invalid.');
    }

    const expected = createHmac('sha256', this.cursorSecret).update(payload).digest();
    let actual: Buffer;

    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      throw new HttpError(400, 'CHAT_INVALID_REQUEST', 'The chat cursor is invalid.');
    }

    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpError(400, 'CHAT_INVALID_REQUEST', 'The chat cursor is invalid.');
    }

    let rawPayload: unknown;

    try {
      rawPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    } catch {
      throw new HttpError(400, 'CHAT_INVALID_REQUEST', 'The chat cursor is invalid.');
    }

    const parsed = parseCursorPayload(rawPayload);

    if (parsed.filter !== filter || parsed.query !== query) {
      throw new HttpError(400, 'CHAT_INVALID_REQUEST', 'The chat cursor does not match the query.');
    }

    return {
      activityAt: new Date(parsed.activity_at),
      conversationId: parsed.conversation_id,
    };
  }

  private async publishSafely(event: ChatDomainEvent): Promise<void> {
    try {
      await this.eventPublisher.publish(event);
    } catch {
      console.error('Chat realtime publication failed after a durable commit.');
    }
  }
}
