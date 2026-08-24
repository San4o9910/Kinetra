import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChatConversationSummaryDto } from '../src/features/chat/types.js';
import {
  recoverAuthorizedTrainerConversationSummary,
  TrainerSelectedConversationStore,
} from '../src/features/trainer-chat/selectedConversation.js';

const summary = (
  id: string,
  displayName: string,
  unreadCount: number,
): ChatConversationSummaryDto => ({
  id,
  client: {
    display_name: displayName,
    avatar_url: null,
    secondary_label: `${displayName.toLocaleLowerCase('ru-RU')}@example.test`,
  },
  last_message: {
    kind: 'text',
    preview: 'Сообщение',
    created_at: '2026-08-24T08:00:00.000Z',
  },
  unread_count: unreadCount,
  activity_at: '2026-08-24T08:00:00.000Z',
});

test('selected trainer summary survives unread-to-read filtered-page omission', () => {
  const store = new TrainerSelectedConversationStore();
  const selected = summary('conversation-selected', 'Анна Точная', 1);
  store.remember([selected]);

  // A refreshed `unread` page legitimately omits the now-read conversation.
  store.applyPatch(selected.id, { unreadCount: 0 });
  store.remember([]);

  assert.deepEqual(store.get(selected.id), {
    ...selected,
    unread_count: 0,
  });
  assert.equal(store.get(selected.id)?.client.display_name, 'Анна Точная');
});

test('deep-linked trainer detail resolves exact authorized identity with one direct lookup', async () => {
  const target = summary('conversation-any-page', 'Мария Точная', 0);
  const lookups: Array<{ readonly conversationId: string; readonly signal?: AbortSignal }> = [];
  const controller = new AbortController();
  const recovered = await recoverAuthorizedTrainerConversationSummary(
    async (conversationId, signal) => {
      lookups.push({ conversationId, signal });
      return target;
    },
    target.id,
    controller.signal,
  );

  assert.equal(recovered?.client.display_name, 'Мария Точная');
  assert.deepEqual(lookups, [{ conversationId: target.id, signal: controller.signal }]);
});

test('unassigned deep-linked conversation never produces a fabricated summary', async () => {
  const recovered = await recoverAuthorizedTrainerConversationSummary(
    async () => null,
    'unassigned-conversation',
    new AbortController().signal,
  );

  assert.equal(recovered, null);
});

test('aborted deep-link lookup fails closed before making a request', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;

  await assert.rejects(
    recoverAuthorizedTrainerConversationSummary(
      async () => {
        called = true;
        return summary('conversation-aborted', 'Отменённая', 0);
      },
      'conversation-aborted',
      controller.signal,
    ),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(called, false);
});
