export type ChatRole = 'client' | 'trainer';
export type ChatMessageKind = 'text' | 'photo';
export type ChatPhotoStatus = 'processing' | 'ready' | 'attached' | 'failed';

export interface ChatActor {
  readonly userId: string;
  readonly role: ChatRole;
  readonly onboardingStatus: 'survey_pending' | 'onboarding_pending' | 'base_lessons' | 'active';
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface ChatParticipant {
  readonly userId: string;
  readonly displayName: string;
  readonly secondaryLabel: string;
  readonly avatarUrl: string | null;
}

export interface ChatPhotoSnapshot {
  readonly id: string;
  readonly conversationId: string;
  readonly uploaderUserId: string;
  readonly clientUploadId: string;
  readonly objectKey: string;
  readonly status: ChatPhotoStatus;
  readonly mimeType: 'image/webp';
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly expiresAt: Date;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly attachedAt: Date | null;
}

export interface ChatMessageSnapshot {
  readonly id: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly senderUserId: string;
  readonly senderRole: ChatRole;
  readonly senderName: string;
  readonly clientMessageId: string;
  readonly requestFingerprint: string;
  readonly kind: ChatMessageKind;
  readonly body: string | null;
  readonly photo: ChatPhotoSnapshot | null;
  readonly createdAt: Date;
}

export interface ChatConversationSnapshot {
  readonly id: string;
  readonly client: ChatParticipant;
  readonly trainer: ChatParticipant;
  readonly lastMessage: ChatMessageSnapshot | null;
  readonly lastMessageSequence: number;
  readonly clientLastReadSequence: number;
  readonly trainerLastReadSequence: number;
  readonly clientUnreadCount: number;
  readonly trainerUnreadCount: number;
  readonly createdAt: Date;
  readonly activityAt: Date;
}

export interface CreateConversationResult {
  readonly created: boolean;
  readonly conversation: ChatConversationSnapshot;
}

export interface ConversationCursor {
  readonly activityAt: Date;
  readonly conversationId: string;
}

export interface ListConversationsInput {
  readonly trainerUserId: string;
  readonly filter: 'all' | 'unread';
  readonly query: string | null;
  readonly cursor: ConversationCursor | null;
  readonly limit: number;
}

export interface ConversationPage {
  readonly items: readonly ChatConversationSnapshot[];
  readonly hasMore: boolean;
}

export interface ListMessagesInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly beforeSequence: number | null;
  readonly afterSequence: number | null;
  readonly limit: number;
}

export interface MessagePage {
  readonly conversation: ChatConversationSnapshot;
  readonly messages: readonly ChatMessageSnapshot[];
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
}

export interface SendMessageRepositoryInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly requestFingerprint: string;
  readonly kind: ChatMessageKind;
  readonly body: string | null;
  readonly photoId: string | null;
  readonly now: Date;
}

export type SendMessageRepositoryResult =
  | {
      readonly kind: 'created';
      readonly conversation: ChatConversationSnapshot;
      readonly message: ChatMessageSnapshot;
    }
  | {
      readonly kind: 'replay';
      readonly conversation: ChatConversationSnapshot;
      readonly message: ChatMessageSnapshot;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_available' }
  | { readonly kind: 'idempotency_conflict' }
  | { readonly kind: 'photo_not_ready' }
  | { readonly kind: 'photo_already_attached' };

export interface ReadRepositoryInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly throughSequence: number;
  readonly now: Date;
}

export type ReadRepositoryResult =
  | {
      readonly kind: 'updated' | 'unchanged';
      readonly conversation: ChatConversationSnapshot;
      readonly readerRole: ChatRole;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'future_cursor' };

export interface ReservePhotoInput {
  readonly id: string;
  readonly conversationId: string;
  readonly uploaderUserId: string;
  readonly clientUploadId: string;
  readonly inputSha256: string;
  readonly objectKey: string;
  readonly expiresAt: Date;
  readonly leaseExpiresAt: Date;
  readonly now: Date;
}

export type ReservePhotoResult =
  | { readonly kind: 'reserved'; readonly photo: ChatPhotoSnapshot }
  | { readonly kind: 'processing' | 'ready' | 'attached'; readonly photo: ChatPhotoSnapshot }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'idempotency_conflict' }
  | { readonly kind: 'retry_exhausted' };

export interface ReadyPhotoInput {
  readonly photoId: string;
  readonly uploaderUserId: string;
  readonly mimeType: 'image/webp';
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly now: Date;
}

export interface PhotoAccessSnapshot {
  readonly photo: ChatPhotoSnapshot;
  readonly canAccess: boolean;
}

export interface MediaDeletionJob {
  readonly objectKey: string;
  readonly attemptCount: number;
}

export interface MediaDeletionBacklog {
  readonly pendingCount: number;
  readonly dueCount: number;
  readonly oldestRequestedAt: Date | null;
}

export interface ChatMediaObjectLease {
  findPhotoStatus(photoId: string, uploaderUserId: string): Promise<ChatPhotoSnapshot | null>;
  markPhotoReady(input: ReadyPhotoInput): Promise<ChatPhotoSnapshot | null>;
  completeMediaDeletion(objectKey: string, now: Date): Promise<void>;
}

export interface TrainerGrantInput {
  readonly userId: string;
  readonly displayName: string;
  readonly makeDefault: boolean;
  readonly now: Date;
}

export interface TrainerReassignInput {
  readonly fromTrainerUserId: string;
  readonly toTrainerUserId: string;
  readonly conversationIds: readonly string[] | null;
  readonly now: Date;
}

export interface ChatRepository {
  withMediaObjectLock<T>(
    objectKey: string,
    operation: (lease: ChatMediaObjectLease) => Promise<T>,
  ): Promise<T>;
  withCurrentConversation<T>(
    conversationId: string,
    operation: (conversation: ChatConversationSnapshot | null) => Promise<T>,
  ): Promise<T>;
  findActor(userId: string): Promise<ChatActor | null>;
  isSessionActive(userId: string, sessionId: string, now: Date): Promise<boolean>;
  findConversationForClient(userId: string): Promise<ChatConversationSnapshot | null>;
  hasActiveDefaultTrainer(): Promise<boolean>;
  countTrainerUnread(userId: string): Promise<number>;
  createOrGetConversation(
    clientUserId: string,
    now: Date,
  ): Promise<CreateConversationResult | null>;
  findTrainerConversation(
    trainerUserId: string,
    conversationId: string,
  ): Promise<ChatConversationSnapshot | null>;
  listTrainerConversations(input: ListConversationsInput): Promise<ConversationPage>;
  listMessages(input: ListMessagesInput): Promise<MessagePage | null>;
  sendMessage(input: SendMessageRepositoryInput): Promise<SendMessageRepositoryResult>;
  markRead(input: ReadRepositoryInput): Promise<ReadRepositoryResult>;
  reservePhoto(input: ReservePhotoInput): Promise<ReservePhotoResult>;
  markPhotoReady(input: ReadyPhotoInput): Promise<ChatPhotoSnapshot | null>;
  markPhotoFailed(
    photoId: string,
    uploaderUserId: string,
    errorCode: string,
    now: Date,
  ): Promise<void>;
  findPhotoStatus(photoId: string, uploaderUserId: string): Promise<ChatPhotoSnapshot | null>;
  findPhotoAccess(photoId: string, userId: string, now: Date): Promise<PhotoAccessSnapshot | null>;
  expireStalePhotos(now: Date, limit: number): Promise<number>;
  claimMediaDeletionJobs(now: Date, limit: number): Promise<readonly MediaDeletionJob[]>;
  getMediaDeletionBacklog(now: Date): Promise<MediaDeletionBacklog>;
  completeMediaDeletion(objectKey: string, now: Date): Promise<void>;
  retryMediaDeletion(objectKey: string, errorCode: string, nextAttemptAt: Date): Promise<void>;
  grantTrainer(
    input: TrainerGrantInput,
  ): Promise<'granted' | 'user_not_found' | 'email_not_verified' | 'client_conversation'>;
  reassignTrainer(input: TrainerReassignInput): Promise<number | null>;
  revokeTrainer(
    userId: string,
    now: Date,
  ): Promise<'revoked' | 'not_found' | 'assigned' | 'default'>;
}
