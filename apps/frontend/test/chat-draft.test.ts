import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chatDraftStorageKey,
  clearAccountChatDrafts,
  clearChatDraft,
  loadChatDraft,
  saveChatDraft,
  type ChatDraftStorage,
} from '../src/features/chat/draft.js';

class MemoryStorage implements ChatDraftStorage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
}

test('T12 draft storage is session-scoped by account and conversation', () => {
  const storage = new MemoryStorage();
  const pendingRequest = {
    client_message_id: '30000000-0000-4000-8000-000000000001',
    kind: 'text' as const,
    text: 'Первый',
  };
  saveChatDraft(
    'account-a',
    'conversation-1',
    { text: 'Первый', photo: null, pendingRequest },
    storage,
  );
  saveChatDraft(
    'account-a',
    'conversation-2',
    { text: 'Второй', photo: null, pendingRequest: null },
    storage,
  );
  saveChatDraft(
    'account-b',
    'conversation-1',
    { text: 'Чужой', photo: null, pendingRequest: null },
    storage,
  );

  assert.equal(loadChatDraft('account-a', 'conversation-1', storage).text, 'Первый');
  assert.deepEqual(
    loadChatDraft('account-a', 'conversation-1', storage).pendingRequest,
    pendingRequest,
  );
  assert.equal(loadChatDraft('account-b', 'conversation-1', storage).text, 'Чужой');
  assert.notEqual(
    chatDraftStorageKey('account-a', 'conversation-1'),
    chatDraftStorageKey('account-b', 'conversation-1'),
  );

  clearChatDraft('account-a', 'conversation-1', storage);
  assert.equal(loadChatDraft('account-a', 'conversation-1', storage).text, '');
  assert.equal(loadChatDraft('account-a', 'conversation-2', storage).text, 'Второй');

  clearAccountChatDrafts('account-a', storage);
  assert.equal(loadChatDraft('account-a', 'conversation-2', storage).text, '');
  assert.equal(loadChatDraft('account-b', 'conversation-1', storage).text, 'Чужой');
});

test('T12 malformed draft never escapes its safe empty fallback', () => {
  const storage = new MemoryStorage();
  storage.setItem(chatDraftStorageKey('account-a', 'conversation-1'), '{broken');
  assert.deepEqual(loadChatDraft('account-a', 'conversation-1', storage), {
    text: '',
    photo: null,
    pendingRequest: null,
  });

  saveChatDraft(
    'account-a',
    'conversation-1',
    { text: '', photo: null, pendingRequest: null },
    storage,
  );
  assert.equal(storage.length, 0);
});
