export type ChatAccountRole = 'client' | 'trainer';

export type ChatMessageKind = 'text' | 'photo';

export type ChatDeliveryStatus = 'sending' | 'sent' | 'read' | 'failed';

export type ChatConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export interface ChatPersonDto {
  readonly display_name: string;
  readonly avatar_url: string | null;
}

export interface ChatClientDto extends ChatPersonDto {
  readonly secondary_label: string;
}

export interface ChatSessionConversationDto {
  readonly id: string;
  readonly trainer: ChatPersonDto;
  readonly last_message_sequence: number;
  readonly last_read_sequence: number;
  readonly counterpart_last_read_sequence: number;
  readonly unread_count: number;
}

export interface ChatClientSessionDto {
  readonly role: 'client';
  readonly enabled: boolean;
  readonly photo_uploads_enabled: boolean;
  readonly available: boolean;
  readonly conversation: ChatSessionConversationDto | null;
}

export interface ChatTrainerSessionDto {
  readonly role: 'trainer';
  readonly enabled: boolean;
  readonly photo_uploads_enabled: boolean;
  readonly profile: ChatPersonDto;
  readonly unread_count: number;
}

export type ChatSessionDto = ChatClientSessionDto | ChatTrainerSessionDto;

export interface ChatPhotoDto {
  readonly id: string;
  readonly status?: 'processing' | 'ready' | 'attached' | 'failed';
  readonly mime_type?: string;
  readonly width?: number;
  readonly height?: number;
  readonly size_bytes?: number;
  readonly expires_at?: string | null;
  readonly failure_code?: string;
  readonly retry_allowed?: boolean;
}

export interface ChatMessageDto {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: number;
  readonly client_message_id: string;
  readonly sender_role: ChatAccountRole;
  readonly is_mine: boolean;
  readonly sender_name: string;
  readonly kind: ChatMessageKind;
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

export interface ChatMessagesPageDto {
  readonly messages: readonly ChatMessageDto[];
  readonly conversation_state: ChatConversationStateDto;
  readonly next_before_sequence: number | null;
  readonly has_more_before: boolean;
  readonly next_after_sequence: number | null;
  readonly has_more_after: boolean;
}

export interface ChatMessageSummaryDto {
  readonly kind: ChatMessageKind;
  readonly preview: string;
  readonly created_at: string;
}

export interface ChatConversationSummaryDto {
  readonly id: string;
  readonly client: ChatClientDto;
  readonly last_message: ChatMessageSummaryDto | null;
  readonly unread_count: number;
  readonly created_at?: string;
  readonly activity_at?: string;
}

export interface ChatInboxPageDto {
  readonly items: readonly ChatConversationSummaryDto[];
  readonly next_cursor: string | null;
}

export interface ChatTextMessageRequest {
  readonly client_message_id: string;
  readonly kind: 'text';
  readonly text: string;
}

export interface ChatPhotoMessageRequest {
  readonly client_message_id: string;
  readonly kind: 'photo';
  readonly text: string | null;
  readonly photo_id: string;
}

export type ChatMessageRequest = ChatTextMessageRequest | ChatPhotoMessageRequest;

export interface ChatPhotoUploadResult {
  readonly photo: ChatPhotoDto;
  readonly retry_after_seconds?: number;
}

export interface ChatPhotoAccessDto {
  readonly url: string;
  readonly expires_at: string;
}

export interface ChatReadResultDto {
  readonly conversation_state: ChatConversationStateDto;
}

export interface ChatMessagesQuery {
  readonly before_sequence?: number;
  readonly after_sequence?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface ChatInboxQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly filter: 'all' | 'unread';
  readonly query?: string;
  readonly signal?: AbortSignal;
}

export interface ChatUploadPhotoInput {
  readonly file: File;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
  readonly onProgress: (percent: number | null) => void;
}

export interface ChatRuntimeApi {
  readonly getSession: (signal?: AbortSignal) => Promise<ChatSessionDto>;
  readonly createConversation: (signal?: AbortSignal) => Promise<ChatSessionConversationDto>;
  readonly getMessages: (
    conversationId: string,
    query: ChatMessagesQuery,
  ) => Promise<ChatMessagesPageDto>;
  readonly sendMessage: (
    conversationId: string,
    request: ChatMessageRequest,
    signal?: AbortSignal,
  ) => Promise<ChatMessageDto>;
  readonly markRead: (
    conversationId: string,
    throughSequence: number,
    signal?: AbortSignal,
  ) => Promise<ChatReadResultDto>;
  readonly uploadPhoto: (
    conversationId: string,
    input: ChatUploadPhotoInput,
  ) => Promise<ChatPhotoUploadResult>;
  readonly getPhotoStatus: (
    photoId: string,
    signal?: AbortSignal,
  ) => Promise<ChatPhotoUploadResult>;
  readonly getPhotoAccess: (photoId: string, signal?: AbortSignal) => Promise<ChatPhotoAccessDto>;
  readonly getInbox: (query: ChatInboxQuery) => Promise<ChatInboxPageDto>;
  readonly getConversationSummary: (
    conversationId: string,
    signal?: AbortSignal,
  ) => Promise<ChatConversationSummaryDto | null>;
}

export interface ChatMessageNewEvent {
  readonly type: 'message:new';
  readonly message: ChatMessageDto;
}

export interface ChatConversationUpdatedEvent {
  readonly type: 'conversation:updated';
  readonly conversation_id: string;
  readonly last_message: ChatMessageSummaryDto | null;
  readonly unread_count: number;
}

export interface ChatReadUpdatedEvent {
  readonly type: 'read:updated';
  readonly conversation_id: string;
  readonly reader_role: ChatAccountRole;
  readonly through_sequence: number;
  readonly read_at: string;
}

export interface ChatSessionInvalidatedEvent {
  readonly type: 'session:invalidated';
}

export interface ChatConnectionEvent {
  readonly type: 'connection';
  readonly state: ChatConnectionState;
}

export type ChatRealtimeEvent =
  | ChatMessageNewEvent
  | ChatConversationUpdatedEvent
  | ChatReadUpdatedEvent
  | ChatSessionInvalidatedEvent
  | ChatConnectionEvent;

export interface ChatRealtimeClient {
  readonly getConnectionState: () => ChatConnectionState;
  readonly subscribe: (listener: (event: ChatRealtimeEvent) => void) => () => void;
  readonly connect: () => void;
  readonly disconnect: () => void;
  readonly sync: (conversationId: string, lastSequence: number) => void;
}

export interface ChatTimelineMessage {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: number | null;
  readonly client_message_id: string;
  readonly sender_role: ChatAccountRole;
  readonly is_mine: boolean;
  readonly sender_name: string;
  readonly kind: ChatMessageKind;
  readonly text: string | null;
  readonly photo: ChatPhotoDto | null;
  readonly created_at: string;
  readonly delivery_status: ChatDeliveryStatus;
  readonly pending_request?: ChatMessageRequest;
  readonly error_message?: string;
}
