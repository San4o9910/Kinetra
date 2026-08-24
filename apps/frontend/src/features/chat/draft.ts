import type { ChatMessageRequest, ChatPhotoDto } from './types';

export interface ChatDraftSnapshot {
  readonly text: string;
  readonly photo: ChatPhotoDto | null;
  readonly pendingRequest: ChatMessageRequest | null;
}

export interface ChatDraftStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
  readonly key: (index: number) => string | null;
  readonly length: number;
}

const CHAT_DRAFT_PREFIX = 'kinetra.chat.draft.v1:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const safeStorage = (): ChatDraftStorage | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

export const chatDraftStorageKey = (accountId: string, conversationId: string): string =>
  `${CHAT_DRAFT_PREFIX}${accountId}:${conversationId}`;

const isPhotoSnapshot = (value: unknown): value is ChatPhotoDto => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as { readonly id?: unknown; readonly status?: unknown };
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    (candidate.status === undefined ||
      candidate.status === 'ready' ||
      candidate.status === 'processing')
  );
};

const isPendingRequest = (value: unknown): value is ChatMessageRequest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as {
    readonly client_message_id?: unknown;
    readonly kind?: unknown;
    readonly text?: unknown;
    readonly photo_id?: unknown;
  };
  if (
    typeof candidate.client_message_id !== 'string' ||
    !UUID_PATTERN.test(candidate.client_message_id)
  ) {
    return false;
  }

  if (candidate.kind === 'text') {
    return typeof candidate.text === 'string';
  }

  return (
    candidate.kind === 'photo' &&
    (candidate.text === null || typeof candidate.text === 'string') &&
    typeof candidate.photo_id === 'string' &&
    UUID_PATTERN.test(candidate.photo_id)
  );
};

export const loadChatDraft = (
  accountId: string,
  conversationId: string,
  storage: ChatDraftStorage | null = safeStorage(),
): ChatDraftSnapshot => {
  if (storage === null) {
    return { text: '', photo: null, pendingRequest: null };
  }

  try {
    const serialized = storage.getItem(chatDraftStorageKey(accountId, conversationId));
    if (serialized === null) {
      return { text: '', photo: null, pendingRequest: null };
    }

    const parsed = JSON.parse(serialized) as {
      readonly text?: unknown;
      readonly photo?: unknown;
      readonly pendingRequest?: unknown;
    };
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      photo: isPhotoSnapshot(parsed.photo) ? parsed.photo : null,
      pendingRequest: isPendingRequest(parsed.pendingRequest) ? parsed.pendingRequest : null,
    };
  } catch {
    return { text: '', photo: null, pendingRequest: null };
  }
};

export const saveChatDraft = (
  accountId: string,
  conversationId: string,
  draft: ChatDraftSnapshot,
  storage: ChatDraftStorage | null = safeStorage(),
): void => {
  if (storage === null) {
    return;
  }

  try {
    const key = chatDraftStorageKey(accountId, conversationId);
    if (draft.text.length === 0 && draft.photo === null) {
      storage.removeItem(key);
      return;
    }

    storage.setItem(key, JSON.stringify(draft));
  } catch {
    // Draft persistence is optional in hardened/private browser modes.
  }
};

export const clearChatDraft = (
  accountId: string,
  conversationId: string,
  storage: ChatDraftStorage | null = safeStorage(),
): void => {
  try {
    storage?.removeItem(chatDraftStorageKey(accountId, conversationId));
  } catch {
    // Draft cleanup remains best-effort when storage is unavailable.
  }
};

export const clearAccountChatDrafts = (
  accountId: string,
  storage: ChatDraftStorage | null = safeStorage(),
): void => {
  if (storage === null) {
    return;
  }

  try {
    const accountPrefix = `${CHAT_DRAFT_PREFIX}${accountId}:`;
    const matchingKeys: string[] = [];

    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(accountPrefix) === true) {
        matchingKeys.push(key);
      }
    }

    matchingKeys.forEach((key) => storage.removeItem(key));
  } catch {
    // Draft cleanup remains best-effort when storage is unavailable.
  }
};
