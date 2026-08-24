import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChatFloatingButton } from '../src/features/chat/ChatFloatingButton.js';
import { ConversationView } from '../src/features/chat/ConversationView.js';
import { MessageList } from '../src/features/chat/MessageList.js';
import type {
  ChatRealtimeClient,
  ChatRuntimeApi,
  ChatTimelineMessage,
} from '../src/features/chat/types.js';
import { TrainerChatsScreen } from '../src/features/trainer-chat/TrainerChatsScreen.js';

const api: ChatRuntimeApi = {
  getSession: async () => ({
    role: 'client',
    enabled: true,
    photo_uploads_enabled: false,
    available: true,
    conversation: null,
  }),
  createConversation: async () => ({
    id: 'conversation-1',
    trainer: { display_name: 'Тренер Kinetra', avatar_url: null },
    last_message_sequence: 0,
    last_read_sequence: 0,
    counterpart_last_read_sequence: 0,
    unread_count: 0,
  }),
  getMessages: async () => ({
    messages: [],
    conversation_state: {
      last_message_sequence: 0,
      own_last_read_sequence: 0,
      counterpart_last_read_sequence: 0,
      unread_count: 0,
    },
    next_before_sequence: null,
    has_more_before: false,
    next_after_sequence: null,
    has_more_after: false,
  }),
  sendMessage: async (_conversationId, request) => ({
    id: 'message-1',
    conversation_id: 'conversation-1',
    sequence: 1,
    client_message_id: request.client_message_id,
    sender_role: 'client',
    is_mine: true,
    sender_name: 'Анна',
    kind: request.kind,
    text: request.text,
    photo: request.kind === 'photo' ? { id: request.photo_id } : null,
    created_at: '2026-08-24T08:00:00.000Z',
  }),
  markRead: async () => ({
    conversation_state: {
      last_message_sequence: 1,
      own_last_read_sequence: 1,
      counterpart_last_read_sequence: 0,
      unread_count: 0,
    },
  }),
  uploadPhoto: async () => ({ photo: { id: 'photo-1', status: 'ready' } }),
  getPhotoStatus: async () => ({ photo: { id: 'photo-1', status: 'ready' } }),
  getPhotoAccess: async () => ({
    url: 'https://media.example.test/photo.webp',
    expires_at: '2026-08-24T08:05:00.000Z',
  }),
  getInbox: async () => ({ items: [], next_cursor: null }),
  getConversationSummary: async () => null,
};

const realtime: ChatRealtimeClient = {
  getConnectionState: () => 'connected',
  subscribe: () => () => undefined,
  connect: () => undefined,
  disconnect: () => undefined,
  sync: () => undefined,
};

const assertFloatingButtonAcceptance = (): void => {
  const zero = renderToStaticMarkup(
    createElement(ChatFloatingButton, { unreadCount: 0, onOpen: () => undefined }),
  );
  assert.ok(zero.includes('aria-label="Чат с тренером"'));
  assert.equal(zero.includes('chat-fab-badge'), false);

  const many = renderToStaticMarkup(
    createElement(ChatFloatingButton, { unreadCount: 100, onOpen: () => undefined }),
  );
  assert.ok(many.includes('99+'));
  assert.ok(many.includes('99+ непрочитанных сообщений'));
};

const assertMessageListAcceptance = (): void => {
  const messages: ChatTimelineMessage[] = [
    {
      id: 'message-1',
      conversation_id: 'conversation-1',
      sequence: 1,
      client_message_id: 'client-message-1',
      sender_role: 'trainer',
      is_mine: false,
      sender_name: 'Тренер Kinetra',
      kind: 'text',
      text: '<img src=x onerror=alert(1)>\nСтрока 2',
      photo: null,
      created_at: '2026-08-24T08:00:00.000Z',
      delivery_status: 'sent',
    },
    {
      id: 'optimistic:2',
      conversation_id: 'conversation-1',
      sequence: null,
      client_message_id: 'client-message-2',
      sender_role: 'client',
      is_mine: true,
      sender_name: 'Анна',
      kind: 'text',
      text: 'Не ушло',
      photo: null,
      created_at: '2026-08-24T08:01:00.000Z',
      delivery_status: 'failed',
      pending_request: {
        client_message_id: 'client-message-2',
        kind: 'text',
        text: 'Не ушло',
      },
      error_message: 'Нет сети',
    },
  ];
  const markup = renderToStaticMarkup(
    createElement(MessageList, {
      messages,
      loadingOlder: false,
      hasMoreBefore: false,
      showNewMessagesButton: true,
      loadPhotoAccess: api.getPhotoAccess,
      onOpenPhoto: () => undefined,
      onLoadOlder: () => undefined,
      onRetry: () => undefined,
      onLatestVisibleIncomingSequenceChange: () => undefined,
      onScrollToNewMessages: () => undefined,
    }),
  );
  assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(markup.includes('<img src=x onerror'), false);
  assert.ok(markup.includes('Не отправлено'));
  assert.ok(markup.includes('Повторить'));
  assert.ok(markup.includes('Новые сообщения'));
  assert.ok(markup.includes('aria-label="История сообщений"'));
};

const assertClientConversationAcceptance = (): void => {
  const markup = renderToStaticMarkup(
    createElement(ConversationView, {
      accountId: 'account-1',
      conversationId: 'conversation-1',
      role: 'client',
      ownDisplayName: 'Анна',
      counterpart: { display_name: 'Тренер Kinetra', avatar_url: null },
      api,
      realtime,
      online: true,
      onBack: () => undefined,
      onSessionExpired: () => undefined,
    }),
  );
  assert.ok(markup.includes('<h1 id="chat-conversation-title">Тренер Kinetra</h1>'));
  assert.ok(markup.includes('data-testid="chat-composer"'));
  assert.ok(markup.includes('aria-label="Новое сообщение"'));
  assert.equal(markup.includes('data-testid="chat-attachment-button"'), false);
  assert.equal(markup.includes('Тренер онлайн'), false);

  const photoEnabled = renderToStaticMarkup(
    createElement(ConversationView, {
      accountId: 'account-1',
      conversationId: 'conversation-1',
      role: 'client',
      ownDisplayName: 'Анна',
      counterpart: { display_name: 'Тренер Kinetra', avatar_url: null },
      api,
      realtime,
      online: true,
      photoUploadsEnabled: true,
      onBack: () => undefined,
      onSessionExpired: () => undefined,
    }),
  );
  assert.ok(photoEnabled.includes('data-testid="chat-attachment-button"'));
};

const assertTrainerAdminAcceptance = (): void => {
  const markup = renderToStaticMarkup(
    createElement(TrainerChatsScreen, {
      accountId: 'trainer-1',
      routeConversationId: null,
      session: {
        role: 'trainer',
        enabled: true,
        photo_uploads_enabled: false,
        profile: { display_name: 'Тренер Kinetra', avatar_url: null },
        unread_count: 0,
      },
      api,
      realtime,
      online: true,
      onNavigateConversation: () => undefined,
      onBackToInbox: () => undefined,
      onSessionExpired: () => undefined,
    }),
  );
  assert.ok(markup.includes('<h1 id="trainer-inbox-title">Диалоги</h1>'));
  assert.ok(markup.includes('data-testid="trainer-chat-search"'));
  assert.ok(markup.includes('Непрочитанные'));
  assert.ok(markup.includes('Выберите диалог'));

  const unresolvedDeepLink = renderToStaticMarkup(
    createElement(TrainerChatsScreen, {
      accountId: 'trainer-1',
      routeConversationId: 'conversation-outside-first-page',
      session: {
        role: 'trainer',
        enabled: true,
        photo_uploads_enabled: false,
        profile: { display_name: 'Тренер Kinetra', avatar_url: null },
        unread_count: 0,
      },
      api,
      realtime,
      online: true,
      onNavigateConversation: () => undefined,
      onBackToInbox: () => undefined,
      onSessionExpired: () => undefined,
    }),
  );
  assert.ok(unresolvedDeepLink.includes('data-testid="trainer-chat-detail-resolving"'));
  assert.equal(unresolvedDeepLink.includes('data-testid="chat-composer"'), false);
  assert.equal(unresolvedDeepLink.includes('Клиент Kinetra'), false);
};

test('T12 client and trainer UI executable acceptance', () => {
  assertFloatingButtonAcceptance();
  assertMessageListAcceptance();
  assertClientConversationAcceptance();
  assertTrainerAdminAcceptance();
  console.log('KINETRA_T12_CLIENT_UI=PASS');
  console.log('KINETRA_T12_TRAINER_ADMIN=PASS');
});
