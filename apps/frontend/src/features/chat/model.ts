import { canonicalizeChatTextValue } from '@kinetra/shared';

import type {
  ChatConversationStateDto,
  ChatConversationSummaryDto,
  ChatDeliveryStatus,
  ChatMessageDto,
  ChatMessageRequest,
  ChatMessageSummaryDto,
  ChatPhotoDto,
  ChatTimelineMessage,
} from './types';

export const CHAT_TEXT_MAX_CODE_POINTS = 2_000;
export const CHAT_CAPTION_MAX_CODE_POINTS = 1_000;
export const CHAT_PHOTO_MAX_BYTES = 10 * 1_024 * 1_024;
export const CHAT_PHOTO_MAX_PIXELS = 20_000_000;
export const CHAT_PHOTO_MAX_SIDE = 8_192;

const supportedPhotoTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface ChatTextValidation {
  readonly valid: boolean;
  readonly value: string;
  readonly codePointLength: number;
  readonly error: string | null;
}

export const canonicalizeChatText = (value: string): string =>
  canonicalizeChatTextValue(value).value;

export const countCodePoints = (value: string): number => Array.from(value).length;

export const validateChatText = (
  value: string,
  maximum = CHAT_TEXT_MAX_CODE_POINTS,
  allowEmpty = false,
): ChatTextValidation => {
  const canonical = canonicalizeChatTextValue(value);

  if (canonical.hasForbiddenControl) {
    return {
      valid: false,
      value: canonical.value,
      codePointLength: canonical.codePointLength,
      error: 'Сообщение содержит недопустимые управляющие символы.',
    };
  }

  if (!allowEmpty && canonical.codePointLength === 0) {
    return {
      valid: false,
      value: canonical.value,
      codePointLength: canonical.codePointLength,
      error: 'Введите сообщение.',
    };
  }

  if (canonical.codePointLength > maximum) {
    return {
      valid: false,
      value: canonical.value,
      codePointLength: canonical.codePointLength,
      error: `Максимальная длина — ${maximum.toLocaleString('ru-RU')} символов.`,
    };
  }

  return {
    valid: true,
    value: canonical.value,
    codePointLength: canonical.codePointLength,
    error: null,
  };
};

export interface ChatPhotoValidation {
  readonly valid: boolean;
  readonly error: string | null;
  readonly code: 'ok' | 'unsupported' | 'heic_unsupported' | 'too_large' | 'dimensions_invalid';
}

export const validateChatPhotoBasics = (file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}): ChatPhotoValidation => {
  const looksLikeHeic = /\.(?:heic|heif)$/iu.test(file.name) || /image\/hei[cf]/iu.test(file.type);

  if (looksLikeHeic) {
    return {
      valid: false,
      code: 'heic_unsupported',
      error: 'Формат HEIC пока не поддерживается. Выберите JPEG, PNG или WebP.',
    };
  }

  if (!supportedPhotoTypes.has(file.type.toLowerCase())) {
    return {
      valid: false,
      code: 'unsupported',
      error: 'Поддерживаются только JPEG, PNG и WebP.',
    };
  }

  if (file.size <= 0 || file.size > CHAT_PHOTO_MAX_BYTES) {
    return {
      valid: false,
      code: 'too_large',
      error: 'Размер фотографии должен быть не больше 10 МБ.',
    };
  }

  return { valid: true, code: 'ok', error: null };
};

export const validateChatPhotoDimensions = (width: number, height: number): ChatPhotoValidation => {
  const validNumbers =
    Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;

  if (
    !validNumbers ||
    width > CHAT_PHOTO_MAX_SIDE ||
    height > CHAT_PHOTO_MAX_SIDE ||
    width * height > CHAT_PHOTO_MAX_PIXELS
  ) {
    return {
      valid: false,
      code: 'dimensions_invalid',
      error: 'Фотография слишком большая по разрешению.',
    };
  }

  return { valid: true, code: 'ok', error: null };
};

export interface ChatPhotoFailurePresentation {
  readonly failureCode: string | null;
  readonly retryAllowed: boolean;
  readonly message: string;
}

export const chatPhotoFailurePresentation = (
  photo: ChatPhotoDto,
): ChatPhotoFailurePresentation | null => {
  if (photo.status !== 'failed') {
    return null;
  }

  const retryAllowed = photo.retry_allowed === true;
  return {
    failureCode: photo.failure_code ?? null,
    retryAllowed,
    message: retryAllowed
      ? 'Не удалось безопасно обработать фотографию. Повторите попытку или выберите другой файл.'
      : 'Повторные попытки обработки исчерпаны. Удалите фотографию и выберите другой файл.',
  };
};

export const canRetryChatPhotoUpload = (photo: ChatPhotoDto | null): boolean =>
  photo?.status !== 'failed' || photo.retry_allowed === true;

export const formatChatFileSize = (bytes: number): string => {
  if (bytes < 1_024) {
    return `${bytes} Б`;
  }

  if (bytes < 1_024 * 1_024) {
    return `${Math.round(bytes / 1_024)} КБ`;
  }

  return `${(bytes / (1_024 * 1_024)).toLocaleString('ru-RU', {
    maximumFractionDigits: 1,
  })} МБ`;
};

const canonicalDeliveryStatus = (
  message: ChatMessageDto,
  counterpartLastReadSequence: number,
): ChatDeliveryStatus =>
  message.is_mine && message.sequence <= counterpartLastReadSequence ? 'read' : 'sent';

export const toTimelineMessage = (
  message: ChatMessageDto,
  counterpartLastReadSequence = 0,
): ChatTimelineMessage => ({
  ...message,
  delivery_status: canonicalDeliveryStatus(message, counterpartLastReadSequence),
});

export const createOptimisticMessage = (
  conversationId: string,
  senderRole: 'client' | 'trainer',
  senderName: string,
  request: ChatMessageRequest,
  createdAt = new Date().toISOString(),
): ChatTimelineMessage => ({
  id: `optimistic:${request.client_message_id}`,
  conversation_id: conversationId,
  sequence: null,
  client_message_id: request.client_message_id,
  sender_role: senderRole,
  is_mine: true,
  sender_name: senderName,
  kind: request.kind,
  text: request.text,
  photo:
    request.kind === 'photo'
      ? {
          id: request.photo_id,
          status: 'ready',
        }
      : null,
  created_at: createdAt,
  delivery_status: 'sending',
  pending_request: request,
});

const timelineSort = (left: ChatTimelineMessage, right: ChatTimelineMessage): number => {
  if (left.sequence !== null && right.sequence !== null) {
    return left.sequence - right.sequence;
  }

  if (left.sequence !== null) {
    return -1;
  }

  if (right.sequence !== null) {
    return 1;
  }

  const createdComparison = left.created_at.localeCompare(right.created_at);
  return createdComparison === 0
    ? left.client_message_id.localeCompare(right.client_message_id)
    : createdComparison;
};

const messageMatchesRequestPayload = (
  message: ChatTimelineMessage | ChatMessageDto,
  request: ChatMessageRequest,
): boolean =>
  message.kind === request.kind &&
  message.text === request.text &&
  (request.kind === 'text' ? message.photo === null : message.photo?.id === request.photo_id);

const ownMessageReconciliationKey = (
  message: ChatTimelineMessage | ChatMessageDto,
): string | undefined => {
  if (!message.is_mine || (message.kind === 'text' && message.photo !== null)) {
    return undefined;
  }

  const photoId = message.kind === 'photo' ? message.photo?.id : null;
  if (message.kind === 'photo' && photoId === undefined) {
    return undefined;
  }

  return JSON.stringify([
    message.conversation_id,
    message.sender_role,
    message.client_message_id,
    message.kind,
    message.text,
    photoId,
  ]);
};

const ownOptimisticMatchesCanonical = (
  optimistic: ChatTimelineMessage,
  canonical: ChatTimelineMessage | ChatMessageDto,
): boolean =>
  optimistic.sequence === null &&
  optimistic.is_mine &&
  optimistic.pending_request !== undefined &&
  canonical.sequence !== null &&
  canonical.is_mine &&
  ownMessageReconciliationKey(optimistic) === ownMessageReconciliationKey(canonical) &&
  messageMatchesRequestPayload(optimistic, optimistic.pending_request) &&
  messageMatchesRequestPayload(canonical, optimistic.pending_request);

export const findMatchingOwnOptimisticMessage = (
  messages: readonly ChatTimelineMessage[],
  canonical: ChatMessageDto,
): ChatTimelineMessage | undefined =>
  canonical.is_mine
    ? messages.find((message) => ownOptimisticMatchesCanonical(message, canonical))
    : undefined;

export const nextRealtimeUnreadCount = (
  currentUnreadCount: number,
  message: Pick<ChatMessageDto, 'is_mine'>,
  alreadyPresentByServerId: boolean,
): number =>
  message.is_mine || alreadyPresentByServerId ? currentUnreadCount : currentUnreadCount + 1;

export const mergeTimelineMessages = (
  current: readonly ChatTimelineMessage[],
  incoming: readonly (ChatTimelineMessage | ChatMessageDto)[],
  counterpartLastReadSequence = 0,
): readonly ChatTimelineMessage[] => {
  const byId = new Map<string, ChatTimelineMessage>();

  const add = (candidate: ChatTimelineMessage | ChatMessageDto): void => {
    const normalized: ChatTimelineMessage =
      'delivery_status' in candidate
        ? candidate
        : toTimelineMessage(candidate, counterpartLastReadSequence);

    const sameId = byId.get(normalized.id);
    if (sameId !== undefined && sameId.sequence !== null && normalized.sequence === null) {
      return;
    }

    byId.set(normalized.id, normalized);
  };

  current.forEach(add);
  incoming.forEach(add);

  const ownCanonicalReconciliationKeys = new Set<string>();
  for (const message of byId.values()) {
    if (message.sequence !== null) {
      const key = ownMessageReconciliationKey(message);
      if (key !== undefined) {
        ownCanonicalReconciliationKeys.add(key);
      }
    }
  }

  for (const message of byId.values()) {
    const key = ownMessageReconciliationKey(message);
    if (
      message.sequence === null &&
      message.pending_request !== undefined &&
      key !== undefined &&
      messageMatchesRequestPayload(message, message.pending_request) &&
      ownCanonicalReconciliationKeys.has(key)
    ) {
      byId.delete(message.id);
    }
  }

  return [...byId.values()]
    .map((message) =>
      message.sequence !== null && message.is_mine
        ? {
            ...message,
            delivery_status:
              message.sequence <= counterpartLastReadSequence
                ? ('read' as const)
                : ('sent' as const),
          }
        : message,
    )
    .sort(timelineSort);
};

export const markTimelineMessageFailed = (
  messages: readonly ChatTimelineMessage[],
  clientMessageId: string,
  errorMessage: string,
): readonly ChatTimelineMessage[] =>
  messages.map((message) =>
    message.client_message_id === clientMessageId &&
    message.sequence === null &&
    message.is_mine &&
    message.pending_request !== undefined
      ? { ...message, delivery_status: 'failed', error_message: errorMessage }
      : message,
  );

export const markTimelineMessageSending = (
  messages: readonly ChatTimelineMessage[],
  clientMessageId: string,
): readonly ChatTimelineMessage[] =>
  messages.map((message) => {
    if (
      message.client_message_id !== clientMessageId ||
      message.sequence !== null ||
      !message.is_mine ||
      message.pending_request === undefined
    ) {
      return message;
    }

    const { error_message: _errorMessage, ...withoutError } = message;
    return { ...withoutError, delivery_status: 'sending' };
  });

export const reconcileTimelineReadState = (
  messages: readonly ChatTimelineMessage[],
  counterpartLastReadSequence: number,
): readonly ChatTimelineMessage[] =>
  messages.map((message) => {
    if (!message.is_mine || message.sequence === null) {
      return message;
    }

    return {
      ...message,
      delivery_status:
        message.sequence <= counterpartLastReadSequence ? ('read' as const) : ('sent' as const),
    };
  });

export const latestTimelineSequence = (messages: readonly ChatTimelineMessage[]): number =>
  messages.reduce(
    (latest, message) => (message.sequence === null ? latest : Math.max(latest, message.sequence)),
    0,
  );

export const advanceChatRestSequence = (
  currentSequence: number,
  messages: readonly { readonly sequence: number }[],
): number =>
  messages.reduce((latest, message) => Math.max(latest, message.sequence), currentSequence);

export interface ChatReadDecisionInput {
  readonly conversationOpen: boolean;
  readonly documentVisible: boolean;
  readonly pageLoaded: boolean;
  readonly latestVisibleIncomingSequence: number | null;
  readonly ownLastReadSequence: number;
}

export const nextChatReadSequence = ({
  conversationOpen,
  documentVisible,
  pageLoaded,
  latestVisibleIncomingSequence,
  ownLastReadSequence,
}: ChatReadDecisionInput): number | null =>
  conversationOpen &&
  documentVisible &&
  pageLoaded &&
  latestVisibleIncomingSequence !== null &&
  latestVisibleIncomingSequence > ownLastReadSequence
    ? latestVisibleIncomingSequence
    : null;

export const restorePrependScrollTop = (
  previousScrollHeight: number,
  previousScrollTop: number,
  nextScrollHeight: number,
): number => Math.max(0, previousScrollTop + nextScrollHeight - previousScrollHeight);

const localDayKey = (date: Date): string =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export const chatDateLabel = (timestamp: string, now = new Date()): string => {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  if (localDayKey(date) === localDayKey(now)) {
    return 'Сегодня';
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (localDayKey(date) === localDayKey(yesterday)) {
    return 'Вчера';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  }).format(date);
};

export const chatTimeLabel = (timestamp: string): string => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date);
};

export const chatUnreadBadge = (unreadCount: number): string | null => {
  if (!Number.isFinite(unreadCount) || unreadCount <= 0) {
    return null;
  }

  return unreadCount > 99 ? '99+' : String(Math.floor(unreadCount));
};

export const chatFabAccessibleName = (unreadCount: number): string => {
  const badge = chatUnreadBadge(unreadCount);
  return badge === null ? 'Чат с тренером' : `Чат с тренером, ${badge} непрочитанных сообщений`;
};

const conversationActivity = (conversation: ChatConversationSummaryDto): string =>
  conversation.activity_at ??
  conversation.last_message?.created_at ??
  conversation.created_at ??
  '1970-01-01T00:00:00.000Z';

export const sortChatInbox = (
  conversations: readonly ChatConversationSummaryDto[],
): readonly ChatConversationSummaryDto[] =>
  [...conversations].sort((left, right) => {
    const activityComparison = conversationActivity(right).localeCompare(
      conversationActivity(left),
    );
    return activityComparison === 0 ? right.id.localeCompare(left.id) : activityComparison;
  });

export interface ChatInboxPatch {
  readonly conversationId: string;
  readonly version: number;
  readonly unreadCount: number;
  readonly lastMessage?: ChatMessageSummaryDto | null;
}

export const applyChatInboxPatches = (
  conversations: readonly ChatConversationSummaryDto[],
  patches: readonly ChatInboxPatch[],
  afterVersion: number,
): readonly ChatConversationSummaryDto[] => {
  const patchByConversation = new Map(
    patches
      .filter((patch) => patch.version > afterVersion)
      .map((patch) => [patch.conversationId, patch] as const),
  );

  return sortChatInbox(
    conversations.map((conversation) => {
      const patch = patchByConversation.get(conversation.id);
      if (patch === undefined) {
        return conversation;
      }

      return {
        ...conversation,
        unread_count: patch.unreadCount,
        ...(patch.lastMessage === undefined
          ? {}
          : {
              last_message: patch.lastMessage,
              ...(patch.lastMessage === null ? {} : { activity_at: patch.lastMessage.created_at }),
            }),
      };
    }),
  );
};

export const applyConversationState = (
  current: ChatConversationStateDto,
  incoming: ChatConversationStateDto,
): ChatConversationStateDto => ({
  last_message_sequence: Math.max(current.last_message_sequence, incoming.last_message_sequence),
  own_last_read_sequence: Math.max(current.own_last_read_sequence, incoming.own_last_read_sequence),
  counterpart_last_read_sequence: Math.max(
    current.counterpart_last_read_sequence,
    incoming.counterpart_last_read_sequence,
  ),
  unread_count:
    incoming.last_message_sequence < current.last_message_sequence ||
    incoming.own_last_read_sequence < current.own_last_read_sequence
      ? current.unread_count
      : incoming.unread_count,
});
