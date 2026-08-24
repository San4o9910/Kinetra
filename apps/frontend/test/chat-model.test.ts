import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CHAT_CAPTION_MAX_CODE_POINTS,
  advanceChatRestSequence,
  applyChatInboxPatches,
  applyConversationState,
  canonicalizeChatText,
  chatDateLabel,
  chatFabAccessibleName,
  chatUnreadBadge,
  createOptimisticMessage,
  markTimelineMessageFailed,
  mergeTimelineMessages,
  nextChatReadSequence,
  restorePrependScrollTop,
  sortChatInbox,
  validateChatPhotoBasics,
  validateChatPhotoDimensions,
  validateChatText,
} from '../src/features/chat/model.js';
import type { ChatConversationSummaryDto, ChatMessageDto } from '../src/features/chat/types.js';

const canonicalMessage = (overrides: Partial<ChatMessageDto> = {}): ChatMessageDto => ({
  id: '10000000-0000-4000-8000-000000000001',
  conversation_id: '20000000-0000-4000-8000-000000000001',
  sequence: 1,
  client_message_id: '30000000-0000-4000-8000-000000000001',
  sender_role: 'client',
  is_mine: true,
  sender_name: 'Анна',
  kind: 'text',
  text: 'Привет',
  photo: null,
  created_at: '2026-08-24T08:00:00.000Z',
  ...overrides,
});

test('T12 text canonicalization is NFC, CRLF-safe, trimmed and code-point bounded', () => {
  assert.equal(canonicalizeChatText('  Cafe\u0301\r\nтест  '), 'Café\nтест');
  assert.equal(canonicalizeChatText('\u0085Cafe\u0301\u0085'), 'Café');
  assert.equal(canonicalizeChatText('\uFEFFтекст\uFEFF'), '\uFEFFтекст\uFEFF');
  assert.equal(validateChatText('\tстрока 1\r\nстрока 2\t').value, 'строка 1\nстрока 2');
  for (const control of ['\u0000', '\u0001', '\u000b', '\u001f', '\u007f']) {
    assert.equal(validateChatText(`до${control}после`).valid, false);
  }
  assert.deepEqual(validateChatText(' \n '), {
    valid: false,
    value: '',
    codePointLength: 0,
    error: 'Введите сообщение.',
  });
  assert.equal(validateChatText('😀'.repeat(2_000)).valid, true);
  assert.equal(validateChatText('😀'.repeat(2_001)).valid, false);
  assert.equal(validateChatText('', CHAT_CAPTION_MAX_CODE_POINTS, true).valid, true);
});

test('T12 photo preflight rejects HEIC, unsupported, oversized and dangerous dimensions', () => {
  assert.equal(
    validateChatPhotoBasics({ name: 'IMG_0001.HEIC', type: '', size: 10 }).code,
    'heic_unsupported',
  );
  assert.equal(
    validateChatPhotoBasics({ name: 'vector.svg', type: 'image/svg+xml', size: 10 }).code,
    'unsupported',
  );
  assert.equal(
    validateChatPhotoBasics({ name: 'photo.jpg', type: 'image/jpeg', size: 10 * 1_024 * 1_024 + 1 })
      .code,
    'too_large',
  );
  assert.equal(
    validateChatPhotoBasics({ name: 'photo.webp', type: 'image/webp', size: 1_024 }).valid,
    true,
  );
  assert.equal(validateChatPhotoDimensions(8_193, 10).valid, false);
  assert.equal(validateChatPhotoDimensions(5_000, 5_000).valid, false);
  assert.equal(validateChatPhotoDimensions(2_048, 2_048).valid, true);
});

test('T12 optimistic message is reconciled once by client_message_id despite duplicate/reorder', () => {
  const request = {
    client_message_id: '30000000-0000-4000-8000-000000000001',
    kind: 'text' as const,
    text: 'Привет',
  };
  const optimistic = createOptimisticMessage(
    '20000000-0000-4000-8000-000000000001',
    'client',
    'Анна',
    request,
    '2026-08-24T07:59:59.000Z',
  );
  const failed = markTimelineMessageFailed([optimistic], request.client_message_id, 'Нет сети');
  assert.equal(failed[0]?.delivery_status, 'failed');

  const second = canonicalMessage({
    id: '10000000-0000-4000-8000-000000000002',
    sequence: 2,
    client_message_id: '30000000-0000-4000-8000-000000000002',
    text: 'Второе',
  });
  const first = canonicalMessage();
  const merged = mergeTimelineMessages(failed, [second, first, first], 1);

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map(({ sequence }) => sequence),
    [1, 2],
  );
  assert.equal(merged[0]?.id, first.id);
  assert.equal(merged[0]?.delivery_status, 'read');
  assert.equal(merged[1]?.delivery_status, 'sent');

  assert.equal(
    applyConversationState(
      {
        last_message_sequence: 3,
        own_last_read_sequence: 1,
        counterpart_last_read_sequence: 1,
        unread_count: 2,
      },
      {
        last_message_sequence: 2,
        own_last_read_sequence: 0,
        counterpart_last_read_sequence: 0,
        unread_count: 0,
      },
    ).unread_count,
    2,
    'a stale history response must not erase unread state from a newer realtime event',
  );
  assert.equal(
    applyConversationState(
      {
        last_message_sequence: 3,
        own_last_read_sequence: 3,
        counterpart_last_read_sequence: 1,
        unread_count: 0,
      },
      {
        last_message_sequence: 3,
        own_last_read_sequence: 1,
        counterpart_last_read_sequence: 1,
        unread_count: 2,
      },
    ).unread_count,
    0,
    'a stale response with a lower read cursor must not restore an old unread badge',
  );
});

test('T12 REST cursor never advances from a reordered realtime event', () => {
  const restTen = canonicalMessage({ sequence: 10 });
  const realtimeTwelve = canonicalMessage({
    id: '10000000-0000-4000-8000-000000000012',
    sequence: 12,
    client_message_id: '30000000-0000-4000-8000-000000000012',
  });
  const restEleven = canonicalMessage({
    id: '10000000-0000-4000-8000-000000000011',
    sequence: 11,
    client_message_id: '30000000-0000-4000-8000-000000000011',
  });

  const timeline = mergeTimelineMessages([restTen], [realtimeTwelve]);
  let restSequence = advanceChatRestSequence(0, [restTen]);
  assert.equal(restSequence, 10);
  assert.equal(timeline.at(-1)?.sequence, 12);

  restSequence = advanceChatRestSequence(restSequence, [restEleven, realtimeTwelve]);
  assert.equal(restSequence, 12, 'REST delta after 10 must still recover sequence 11');
  assert.deepEqual(
    mergeTimelineMessages(timeline, [restEleven, realtimeTwelve]).map(({ sequence }) => sequence),
    [10, 11, 12],
  );
});

test('T12 read cursor requires an open loaded visible conversation and only advances', () => {
  const ready = {
    conversationOpen: true,
    documentVisible: true,
    pageLoaded: true,
    latestVisibleIncomingSequence: 8,
    ownLastReadSequence: 6,
  };
  assert.equal(nextChatReadSequence(ready), 8);
  assert.equal(nextChatReadSequence({ ...ready, documentVisible: false }), null);
  assert.equal(nextChatReadSequence({ ...ready, pageLoaded: false }), null);
  assert.equal(nextChatReadSequence({ ...ready, latestVisibleIncomingSequence: 6 }), null);
  assert.equal(restorePrependScrollTop(1_000, 40, 1_600), 640);
});

test('T12 badge, dates and trainer inbox sorting have stable boundaries', () => {
  assert.equal(chatUnreadBadge(0), null);
  assert.equal(chatUnreadBadge(1), '1');
  assert.equal(chatUnreadBadge(99), '99');
  assert.equal(chatUnreadBadge(100), '99+');
  assert.equal(chatFabAccessibleName(0), 'Чат с тренером');
  assert.equal(chatFabAccessibleName(100), 'Чат с тренером, 99+ непрочитанных сообщений');

  const now = new Date(2026, 7, 24, 12, 0, 0);
  assert.equal(chatDateLabel(new Date(2026, 7, 24, 8).toISOString(), now), 'Сегодня');
  assert.equal(chatDateLabel(new Date(2026, 7, 23, 8).toISOString(), now), 'Вчера');

  const conversations: ChatConversationSummaryDto[] = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      client: { display_name: 'А', secondary_label: 'a***@test', avatar_url: null },
      last_message: { kind: 'text', preview: 'Старое', created_at: '2026-08-23T10:00:00Z' },
      unread_count: 0,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      client: { display_name: 'Б', secondary_label: 'b***@test', avatar_url: null },
      last_message: { kind: 'photo', preview: '', created_at: '2026-08-24T10:00:00Z' },
      unread_count: 2,
    },
  ];
  assert.deepEqual(
    sortChatInbox(conversations).map(({ id }) => id),
    ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'],
  );

  const stalePage = conversations.map((conversation) => ({ ...conversation, unread_count: 0 }));
  const newerPatch = {
    conversationId: '00000000-0000-4000-8000-000000000001',
    version: 2,
    unreadCount: 3,
    lastMessage: {
      kind: 'text' as const,
      preview: 'Realtime новее начатого GET',
      created_at: '2026-08-24T11:00:00Z',
    },
  };
  const protectedFromStaleGet = applyChatInboxPatches(stalePage, [newerPatch], 1);
  assert.equal(protectedFromStaleGet[0]?.id, newerPatch.conversationId);
  assert.equal(protectedFromStaleGet[0]?.unread_count, 3);
  assert.equal(protectedFromStaleGet[0]?.last_message?.preview, newerPatch.lastMessage.preview);
  assert.equal(
    applyChatInboxPatches(stalePage, [newerPatch], 2).find(
      ({ id }) => id === newerPatch.conversationId,
    )?.unread_count,
    0,
    'a GET started after the realtime patch remains authoritative',
  );
});
