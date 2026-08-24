import { CHAT_CAPTION_MAX_CODE_POINTS, CHAT_TEXT_MAX_CODE_POINTS, validateChatText } from './model';
import type { ChatMessageDto, ChatMessageRequest } from './types';

export interface ChatComposerDraftSnapshot {
  readonly text: string;
  readonly photoId: string | null;
}

export interface ChatComposerAcknowledgement {
  readonly nonce: number;
  readonly request: ChatMessageRequest;
}

const requestPayloadMatches = (left: ChatMessageRequest, right: ChatMessageRequest): boolean =>
  left.kind === right.kind &&
  left.text === right.text &&
  (left.kind === 'text' || (right.kind === 'photo' && left.photo_id === right.photo_id));

export const chatComposerDraftMatchesRequest = (
  draft: ChatComposerDraftSnapshot,
  request: ChatMessageRequest,
): boolean => {
  if (request.kind === 'text') {
    const validation = validateChatText(draft.text, CHAT_TEXT_MAX_CODE_POINTS, false);
    return draft.photoId === null && validation.valid && validation.value === request.text;
  }

  const validation = validateChatText(draft.text, CHAT_CAPTION_MAX_CODE_POINTS, true);
  const caption = validation.value.length === 0 ? null : validation.value;
  return validation.valid && draft.photoId === request.photo_id && caption === request.text;
};

export const shouldClearAcknowledgedComposerDraft = (
  acknowledgement: ChatComposerAcknowledgement,
  pendingRequest: ChatMessageRequest | null,
  draft: ChatComposerDraftSnapshot,
): boolean =>
  pendingRequest !== null &&
  acknowledgement.request.client_message_id === pendingRequest.client_message_id &&
  requestPayloadMatches(acknowledgement.request, pendingRequest) &&
  chatComposerDraftMatchesRequest(draft, pendingRequest);

export const createComposerAcknowledgement = (
  message: ChatMessageDto,
  request: ChatMessageRequest,
  nonce: number,
): ChatComposerAcknowledgement | null => {
  const payloadMatches =
    message.client_message_id === request.client_message_id &&
    message.kind === request.kind &&
    message.text === request.text &&
    (request.kind === 'text' || message.photo?.id === request.photo_id);

  return payloadMatches ? { nonce, request } : null;
};
