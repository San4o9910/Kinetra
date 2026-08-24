import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createComposerAcknowledgement,
  shouldClearAcknowledgedComposerDraft,
} from '../src/features/chat/composerAcknowledgement.js';
import { isTerminalChatAuthError } from '../src/features/chat/authError.js';
import {
  CHAT_PHOTO_ACCESS_MAX_TIMER_MS,
  ChatPhotoAccessLifecycle,
  chatPhotoAccessRenewDelay,
  type ChatPhotoAccessLifecycleState,
  type ChatPhotoAccessScheduler,
} from '../src/features/chat/photoAccessLifecycle.js';
import {
  CHAT_READ_DEBOUNCE_MS,
  CHAT_READ_RETRY_DELAYS_MS,
  ChatReadAcknowledgementLifecycle,
} from '../src/features/chat/readAcknowledgementLifecycle.js';
import { ChatSessionRequestGate } from '../src/features/chat/sessionRequestGate.js';
import type {
  ChatMessageDto,
  ChatMessageRequest,
  ChatPhotoAccessDto,
} from '../src/features/chat/types.js';

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

class FakePhotoAccessScheduler implements ChatPhotoAccessScheduler {
  private nextTimerId = 1;
  private readonly timers = new Map<
    number,
    { readonly dueAt: number; readonly callback: () => void }
  >();
  currentTime: number;

  constructor(now: number) {
    this.currentTime = now;
  }

  readonly now = (): number => this.currentTime;

  readonly setTimer = (callback: () => void, delayMilliseconds: number): number => {
    const timerId = this.nextTimerId++;
    this.timers.set(timerId, {
      dueAt: this.currentTime + delayMilliseconds,
      callback,
    });
    return timerId;
  };

  readonly clearTimer = (timer: unknown): void => {
    if (typeof timer === 'number') {
      this.timers.delete(timer);
    }
  };

  advance(milliseconds: number): void {
    const targetTime = this.currentTime + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, task]) => task.dueAt <= targetTime)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (next === undefined) {
        break;
      }

      const [timerId, task] = next;
      this.timers.delete(timerId);
      this.currentTime = task.dueAt;
      task.callback();
    }
    this.currentTime = targetTime;
  }

  get pendingTimerCount(): number {
    return this.timers.size;
  }
}

test('a deferred stale chat session GET cannot overwrite a newer local read ACK', async () => {
  const gate = new ChatSessionRequestGate();
  const staleGet = deferred<{ readonly lastReadSequence: number }>();
  const ticket = gate.begin();
  let visibleLastReadSequence = 0;

  const staleCompletion = staleGet.promise.then((session) => {
    if (gate.isCurrent(ticket)) {
      visibleLastReadSequence = session.lastReadSequence;
    }
  });

  gate.invalidate();
  visibleLastReadSequence = 9;
  staleGet.resolve({ lastReadSequence: 0 });
  await staleCompletion;

  assert.equal(ticket.controller.signal.aborted, true);
  assert.equal(visibleLastReadSequence, 9);

  const nextTicket = gate.begin();
  assert.equal(gate.isCurrent(nextTicket), true);
});

test('failed read ACK retries automatically and clears authoritative unread state', async () => {
  const scheduler = new FakePhotoAccessScheduler(0);
  const first = deferred<{
    readonly conversation_state: {
      readonly last_message_sequence: number;
      readonly own_last_read_sequence: number;
      readonly counterpart_last_read_sequence: number;
      readonly unread_count: number;
    };
  }>();
  const second = deferred<{
    readonly conversation_state: {
      readonly last_message_sequence: number;
      readonly own_last_read_sequence: number;
      readonly counterpart_last_read_sequence: number;
      readonly unread_count: number;
    };
  }>();
  const requests = [first, second];
  const throughSequences: number[] = [];
  let authoritativeUnread = 3;
  let terminalErrors = 0;
  const lifecycle = new ChatReadAcknowledgementLifecycle({
    scheduler,
    markRead: (throughSequence) => {
      throughSequences.push(throughSequence);
      const request = requests.shift();
      if (request === undefined) throw new Error('Unexpected read ACK request.');
      return request.promise;
    },
    onAcknowledged: (state) => {
      authoritativeUnread = state.unread_count;
    },
    onTerminalError: () => {
      terminalErrors += 1;
    },
    isTerminalError: (error) =>
      typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'auth',
  });

  lifecycle.queue(9);
  scheduler.advance(CHAT_READ_DEBOUNCE_MS);
  assert.deepEqual(throughSequences, [9]);
  first.reject({ code: 'NETWORK_ERROR', kind: 'network' });
  await flushPromises();
  assert.equal(scheduler.pendingTimerCount, 1);

  scheduler.advance(CHAT_READ_RETRY_DELAYS_MS[0]);
  assert.deepEqual(throughSequences, [9, 9]);
  second.resolve({
    conversation_state: {
      last_message_sequence: 9,
      own_last_read_sequence: 9,
      counterpart_last_read_sequence: 0,
      unread_count: 0,
    },
  });
  await flushPromises();

  assert.equal(authoritativeUnread, 0);
  assert.equal(lifecycle.pendingThroughSequence, null);
  assert.equal(scheduler.pendingTimerCount, 0);
  assert.equal(terminalErrors, 0);
  lifecycle.dispose();
});

test('reconnect retries a retained monotonic read ACK immediately', async () => {
  const scheduler = new FakePhotoAccessScheduler(0);
  const first = deferred<never>();
  const second = deferred<{
    readonly conversation_state: {
      readonly last_message_sequence: number;
      readonly own_last_read_sequence: number;
      readonly counterpart_last_read_sequence: number;
      readonly unread_count: number;
    };
  }>();
  const throughSequences: number[] = [];
  let requestIndex = 0;
  let authoritativeUnread = 5;
  const lifecycle = new ChatReadAcknowledgementLifecycle({
    scheduler,
    markRead: (throughSequence) => {
      throughSequences.push(throughSequence);
      requestIndex += 1;
      return requestIndex === 1 ? first.promise : second.promise;
    },
    onAcknowledged: (state) => {
      authoritativeUnread = state.unread_count;
    },
    onTerminalError: () => undefined,
    isTerminalError: () => false,
  });

  lifecycle.queue(7);
  lifecycle.queue(11);
  scheduler.advance(CHAT_READ_DEBOUNCE_MS);
  assert.deepEqual(throughSequences, [11]);
  first.reject({ code: 'REQUEST_FAILED', kind: 'server' });
  await flushPromises();
  assert.equal(scheduler.pendingTimerCount, 1);

  lifecycle.retryNow();
  assert.deepEqual(throughSequences, [11, 11]);
  second.resolve({
    conversation_state: {
      last_message_sequence: 11,
      own_last_read_sequence: 11,
      counterpart_last_read_sequence: 0,
      unread_count: 0,
    },
  });
  await flushPromises();

  assert.equal(authoritativeUnread, 0);
  assert.equal(lifecycle.pendingThroughSequence, null);
  assert.equal(scheduler.pendingTimerCount, 0);
  lifecycle.dispose();
});

test('chat treats only auth-kind subject changes as terminal', () => {
  assert.equal(isTerminalChatAuthError({ code: 'AUTHENTICATION_REQUIRED' }), true);
  assert.equal(isTerminalChatAuthError({ code: 'NO_SESSION' }), true);
  assert.equal(isTerminalChatAuthError({ code: 'AUTH_SESSION_CHANGED', kind: 'auth' }), true);
  assert.equal(isTerminalChatAuthError({ code: 'AUTH_SESSION_CHANGED', kind: 'request' }), false);
  assert.equal(isTerminalChatAuthError({ code: 'NETWORK_ERROR', kind: 'network' }), false);
});

test('a delayed acknowledgement for failed draft A does not clear edited draft B', async () => {
  const requestA: ChatMessageRequest = {
    client_message_id: 'client-message-a',
    kind: 'text',
    text: 'Черновик A',
  };
  const canonicalA: ChatMessageDto = {
    id: 'message-a',
    conversation_id: 'conversation-1',
    sequence: 1,
    client_message_id: requestA.client_message_id,
    sender_role: 'client',
    is_mine: true,
    sender_name: 'Анна',
    kind: 'text',
    text: requestA.text,
    photo: null,
    created_at: '2026-08-24T08:00:00.000Z',
  };
  const retry = deferred<ChatMessageDto>();
  let draft = { text: requestA.text, photoId: null };
  let pendingRequest: ChatMessageRequest | null = requestA;
  let cleared = false;

  const retryCompletion = retry.promise.then((canonical) => {
    const acknowledgement = createComposerAcknowledgement(canonical, requestA, 1);
    if (
      acknowledgement !== null &&
      shouldClearAcknowledgedComposerDraft(acknowledgement, pendingRequest, draft)
    ) {
      cleared = true;
    }
  });

  draft = { text: 'Новый черновик B', photoId: null };
  pendingRequest = null;
  draft = { text: requestA.text, photoId: null };
  pendingRequest = null;
  retry.resolve(canonicalA);
  await retryCompletion;

  assert.equal(cleared, false);
  assert.equal(draft.text, requestA.text, 'the A → B → A edit must remain a distinct draft');

  const acknowledgement = createComposerAcknowledgement(canonicalA, requestA, 2);
  assert.notEqual(acknowledgement, null);
  assert.equal(
    createComposerAcknowledgement({ ...canonicalA, is_mine: false }, requestA, 3),
    null,
    'a counterpart collision must never acknowledge or clear the local draft',
  );
  assert.equal(
    shouldClearAcknowledgedComposerDraft(acknowledgement!, requestA, {
      text: requestA.text,
      photoId: null,
    }),
    true,
  );
  assert.equal(
    shouldClearAcknowledgedComposerDraft(acknowledgement!, requestA, {
      text: 'Новый черновик B',
      photoId: null,
    }),
    false,
  );
});

test('photo access renews on expiry and one image error, then cleans up deterministically', async () => {
  const now = Date.parse('2026-08-24T08:00:00.000Z');
  const scheduler = new FakePhotoAccessScheduler(now);
  const loads: Array<{
    readonly deferred: Deferred<ChatPhotoAccessDto>;
    readonly signal: AbortSignal | undefined;
  }> = [];
  const states: ChatPhotoAccessLifecycleState[] = [];
  const lifecycle = new ChatPhotoAccessLifecycle({
    photoId: 'photo-1',
    scheduler,
    loadAccess: (_photoId, signal) => {
      const next = deferred<ChatPhotoAccessDto>();
      loads.push({ deferred: next, signal });
      return next.promise;
    },
    onStateChange: (state) => states.push(state),
  });

  lifecycle.start();
  assert.equal(loads.length, 1);
  loads[0]!.deferred.resolve({
    url: 'https://media.example.test/photo-1?token=one',
    expires_at: new Date(now + 10_000).toISOString(),
  });
  await flushPromises();
  assert.equal(lifecycle.getState().status, 'ready');
  assert.equal(scheduler.pendingTimerCount, 1);

  scheduler.advance(5_000);
  assert.equal(loads.length, 2);
  assert.equal(lifecycle.getState().status, 'loading');
  assert.equal(lifecycle.getState().access?.url, 'https://media.example.test/photo-1?token=one');

  loads[1]!.deferred.resolve({
    url: 'https://media.example.test/photo-1?token=two',
    expires_at: new Date(scheduler.currentTime + 20_000).toISOString(),
  });
  await flushPromises();
  assert.equal(lifecycle.getState().status, 'ready');

  lifecycle.handleImageError('https://media.example.test/photo-1?token=two');
  assert.equal(loads.length, 3);
  assert.equal(lifecycle.getState().access, null);
  loads[2]!.deferred.resolve({
    url: 'https://media.example.test/photo-1?token=two',
    expires_at: new Date(scheduler.currentTime + 20_000).toISOString(),
  });
  await flushPromises();
  lifecycle.handleImageError('https://media.example.test/photo-1?token=two');
  assert.equal(loads.length, 3, 'the same broken URL must not create an unbounded retry loop');
  assert.equal(lifecycle.getState().status, 'error');
  assert.equal(scheduler.pendingTimerCount, 0);

  lifecycle.refresh();
  assert.equal(loads.length, 4);
  lifecycle.stop();
  assert.equal(loads[3]!.signal?.aborted, true);
  assert.equal(scheduler.pendingTimerCount, 0);
  assert.equal(lifecycle.getState().status, 'idle');
  assert.equal(lifecycle.getState().access, null);
  const stateCountAfterStop = states.length;
  loads[3]!.deferred.resolve({
    url: 'https://media.example.test/photo-1?token=late',
    expires_at: new Date(scheduler.currentTime + 20_000).toISOString(),
  });
  await flushPromises();
  assert.equal(states.length, stateCountAfterStop);

  const timerOnlyLifecycle = new ChatPhotoAccessLifecycle({
    photoId: 'photo-timer-only',
    scheduler,
    loadAccess: async () => {
      throw new Error('A still-valid initial access URL must not load immediately.');
    },
    onStateChange: () => undefined,
  });
  timerOnlyLifecycle.start({
    url: 'https://media.example.test/photo-timer-only?token=one',
    expires_at: new Date(scheduler.currentTime + 120_000).toISOString(),
  });
  assert.equal(scheduler.pendingTimerCount, 1);
  timerOnlyLifecycle.stop();
  assert.equal(scheduler.pendingTimerCount, 0);

  assert.equal(
    chatPhotoAccessRenewDelay(
      new Date(now + 10 * CHAT_PHOTO_ACCESS_MAX_TIMER_MS).toISOString(),
      now,
    ),
    CHAT_PHOTO_ACCESS_MAX_TIMER_MS,
  );
  assert.equal(chatPhotoAccessRenewDelay('not-a-date', now), null);
});
