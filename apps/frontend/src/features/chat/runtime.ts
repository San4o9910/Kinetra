import { useCallback, useEffect, useRef, useState } from 'react';

import { clearAccountChatDrafts } from './draft';
import { isTerminalChatAuthError } from './authError';
import { applyConversationState } from './model';
import { ChatSessionRequestGate } from './sessionRequestGate';
import type {
  ChatAccountRole,
  ChatConnectionState,
  ChatConversationStateDto,
  ChatRealtimeClient,
  ChatRealtimeEvent,
  ChatRuntimeApi,
  ChatSessionDto,
} from './types';

export type ChatRuntimeState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly session: ChatSessionDto }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'disabled' | 'trainer_unavailable' | 'not_available';
    }
  | { readonly kind: 'error'; readonly message: string };

export interface UseChatRuntimeInput {
  readonly accountId: string | null;
  readonly role: ChatAccountRole | null;
  readonly enabled: boolean;
  readonly api: ChatRuntimeApi;
  readonly realtime: ChatRealtimeClient;
  readonly onSessionExpired: () => void;
}

export interface ChatRuntimeValue {
  readonly state: ChatRuntimeState;
  readonly unreadCount: number;
  readonly connectionState: ChatConnectionState;
  readonly refresh: () => void;
  readonly updateClientConversationState: (
    conversationId: string,
    state: ChatConversationStateDto,
  ) => void;
  readonly suspendNow: () => void;
  readonly restartNow: () => void;
  readonly disposeNow: () => void;
  readonly registerObjectUrl: (url: string) => () => void;
}

export interface ChatRuntimeRestartOperations {
  readonly invalidateSessionRequests: () => void;
  readonly unsubscribeCurrent: (() => void) | null;
  readonly disconnect: () => void;
  readonly revokeObjectUrls: () => void;
  readonly available: boolean;
  readonly resetUnavailable: () => void;
  readonly getConnectionState: () => ChatConnectionState;
  readonly setConnectionState: (state: ChatConnectionState) => void;
  readonly subscribe: () => () => void;
  readonly loadSession: () => void;
}

export const restartChatRuntime = (
  operations: ChatRuntimeRestartOperations,
): (() => void) | null => {
  operations.invalidateSessionRequests();
  operations.unsubscribeCurrent?.();
  operations.disconnect();
  operations.revokeObjectUrls();

  if (!operations.available) {
    operations.resetUnavailable();
    return null;
  }

  operations.setConnectionState(operations.getConnectionState());
  const unsubscribe = operations.subscribe();
  operations.loadSession();
  return unsubscribe;
};

const errorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }

  return typeof error.code === 'string' ? error.code : null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'Не удалось подключить чат. Проверьте соединение и попробуйте ещё раз.';

const unavailableState = (session: ChatSessionDto): ChatRuntimeState | null => {
  if (!session.enabled) {
    return { kind: 'unavailable', reason: 'disabled' };
  }

  if (session.role === 'client' && !session.available) {
    return { kind: 'unavailable', reason: 'trainer_unavailable' };
  }

  return null;
};

const sessionUnread = (session: ChatSessionDto): number =>
  session.role === 'client' ? (session.conversation?.unread_count ?? 0) : session.unread_count;

export const useChatRuntime = ({
  accountId,
  role,
  enabled,
  api,
  realtime,
  onSessionExpired,
}: UseChatRuntimeInput): ChatRuntimeValue => {
  const [state, setState] = useState<ChatRuntimeState>({ kind: 'idle' });
  const [unreadCount, setUnreadCount] = useState(0);
  const [connectionState, setConnectionState] = useState<ChatConnectionState>('connecting');
  const sessionRequestGateRef = useRef<ChatSessionRequestGate | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const objectUrlsRef = useRef(new Set<string>());
  const accountIdRef = useRef(accountId);
  const previousAccountIdRef = useRef<string | null>(accountId);
  const roleRef = useRef(role);
  const enabledRef = useRef(enabled);
  const stateRef = useRef<ChatRuntimeState>(state);

  if (sessionRequestGateRef.current === null) {
    sessionRequestGateRef.current = new ChatSessionRequestGate();
  }

  stateRef.current = state;
  accountIdRef.current = accountId;
  roleRef.current = role;
  enabledRef.current = enabled;

  const commitState = useCallback((next: ChatRuntimeState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const revokeObjectUrls = useCallback((): void => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
  }, []);

  const stopRuntime = useCallback(
    (clearDrafts: boolean): void => {
      sessionRequestGateRef.current?.invalidate();
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      realtime.disconnect();
      revokeObjectUrls();

      if (clearDrafts && accountIdRef.current !== null) {
        clearAccountChatDrafts(accountIdRef.current);
      }

      setUnreadCount(0);
      setConnectionState('offline');
      commitState({ kind: 'idle' });
    },
    [commitState, realtime, revokeObjectUrls],
  );

  const suspendNow = useCallback((): void => stopRuntime(false), [stopRuntime]);
  const disposeNow = useCallback((): void => stopRuntime(true), [stopRuntime]);

  const loadSession = useCallback(
    (announceLoading: boolean): void => {
      if (!enabledRef.current || accountIdRef.current === null || roleRef.current === null) {
        return;
      }

      const gate = sessionRequestGateRef.current;
      if (gate === null) {
        return;
      }
      const ticket = gate.begin();
      const { controller } = ticket;

      if (announceLoading) {
        commitState({ kind: 'loading' });
      }

      void api
        .getSession(controller.signal)
        .then((session) => {
          if (!gate.isCurrent(ticket)) {
            return;
          }

          if (session.role !== roleRef.current) {
            commitState({
              kind: 'error',
              message: 'Роль аккаунта в чате изменилась. Войдите снова.',
            });
            realtime.disconnect();
            return;
          }

          const unavailable = unavailableState(session);
          if (unavailable !== null) {
            setUnreadCount(0);
            commitState(unavailable);
            realtime.disconnect();
            return;
          }

          setUnreadCount(sessionUnread(session));
          commitState({ kind: 'ready', session });
          setConnectionState(realtime.getConnectionState());
          realtime.connect();
        })
        .catch((error: unknown) => {
          if (!gate.isCurrent(ticket)) {
            return;
          }

          const code = errorCode(error);
          if (isTerminalChatAuthError(error)) {
            realtime.disconnect();
            onSessionExpired();
            return;
          }

          if (code === 'CHAT_DISABLED') {
            setUnreadCount(0);
            commitState({ kind: 'unavailable', reason: 'disabled' });
            return;
          }

          if (code === 'CHAT_TRAINER_UNAVAILABLE') {
            setUnreadCount(0);
            commitState({ kind: 'unavailable', reason: 'trainer_unavailable' });
            return;
          }

          if (code === 'CHAT_NOT_AVAILABLE') {
            setUnreadCount(0);
            commitState({ kind: 'unavailable', reason: 'not_available' });
            return;
          }

          commitState({ kind: 'error', message: errorMessage(error) });
        })
        .finally(() => {
          gate.finish(ticket);
        });
    },
    [api, commitState, onSessionExpired, realtime],
  );

  const handleRealtimeEvent = useCallback(
    (event: ChatRealtimeEvent): void => {
      if (event.type === 'connection') {
        setConnectionState(event.state);
        if (event.state === 'connected') {
          loadSession(false);
        }
        return;
      }

      if (event.type === 'session:invalidated') {
        realtime.disconnect();
        onSessionExpired();
        return;
      }

      if (event.type === 'read:updated') {
        const current = stateRef.current;
        if (current.kind === 'ready' && event.reader_role === current.session.role) {
          loadSession(false);
        }
        return;
      }

      if (event.type === 'conversation:updated') {
        sessionRequestGateRef.current?.invalidate();
        const current = stateRef.current;
        if (current.kind === 'ready' && current.session.role === 'client') {
          if (current.session.conversation?.id === event.conversation_id) {
            const next: ChatRuntimeState = {
              kind: 'ready',
              session: {
                ...current.session,
                conversation: {
                  ...current.session.conversation,
                  unread_count: event.unread_count,
                },
              },
            };
            setUnreadCount(event.unread_count);
            commitState(next);
          } else {
            loadSession(false);
          }
        } else {
          loadSession(false);
        }
      }
    },
    [commitState, loadSession, onSessionExpired, realtime],
  );

  const restartNow = useCallback((): void => {
    const unsubscribeCurrent = unsubscribeRef.current;
    unsubscribeRef.current = null;
    unsubscribeRef.current = restartChatRuntime({
      invalidateSessionRequests: () => sessionRequestGateRef.current?.invalidate(),
      unsubscribeCurrent,
      disconnect: () => realtime.disconnect(),
      revokeObjectUrls,
      available: enabledRef.current && accountIdRef.current !== null && roleRef.current !== null,
      resetUnavailable: () => {
        setUnreadCount(0);
        setConnectionState('offline');
        commitState({ kind: 'idle' });
      },
      getConnectionState: () => realtime.getConnectionState(),
      setConnectionState,
      subscribe: () => realtime.subscribe(handleRealtimeEvent),
      loadSession: () => loadSession(true),
    });
  }, [commitState, handleRealtimeEvent, loadSession, realtime, revokeObjectUrls]);

  useEffect(() => {
    const previousAccountId = previousAccountIdRef.current;
    if (previousAccountId !== null && previousAccountId !== accountId) {
      clearAccountChatDrafts(previousAccountId);
    }
    previousAccountIdRef.current = accountId;

    sessionRequestGateRef.current?.invalidate();
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    realtime.disconnect();
    revokeObjectUrls();
    setUnreadCount(0);

    if (!enabled || accountId === null || role === null) {
      commitState({ kind: 'idle' });
      return undefined;
    }

    setConnectionState(realtime.getConnectionState());
    unsubscribeRef.current = realtime.subscribe(handleRealtimeEvent);
    loadSession(true);

    return () => {
      sessionRequestGateRef.current?.invalidate();
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      realtime.disconnect();
      revokeObjectUrls();
    };
  }, [
    accountId,
    commitState,
    enabled,
    handleRealtimeEvent,
    loadSession,
    realtime,
    revokeObjectUrls,
    role,
  ]);

  const refresh = useCallback((): void => loadSession(true), [loadSession]);
  const updateClientConversationState = useCallback(
    (conversationId: string, incoming: ChatConversationStateDto): void => {
      const current = stateRef.current;
      if (
        current.kind !== 'ready' ||
        current.session.role !== 'client' ||
        current.session.conversation?.id !== conversationId
      ) {
        return;
      }

      sessionRequestGateRef.current?.invalidate();

      const conversation = current.session.conversation;
      const merged = applyConversationState(
        {
          last_message_sequence: conversation.last_message_sequence,
          own_last_read_sequence: conversation.last_read_sequence,
          counterpart_last_read_sequence: conversation.counterpart_last_read_sequence,
          unread_count: conversation.unread_count,
        },
        incoming,
      );
      const next: ChatRuntimeState = {
        kind: 'ready',
        session: {
          ...current.session,
          conversation: {
            ...conversation,
            last_message_sequence: merged.last_message_sequence,
            last_read_sequence: merged.own_last_read_sequence,
            counterpart_last_read_sequence: merged.counterpart_last_read_sequence,
            unread_count: merged.unread_count,
          },
        },
      };
      setUnreadCount(merged.unread_count);
      commitState(next);
    },
    [commitState],
  );
  const registerObjectUrl = useCallback((url: string): (() => void) => {
    objectUrlsRef.current.add(url);
    return () => {
      if (objectUrlsRef.current.delete(url)) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  return {
    state,
    unreadCount,
    connectionState,
    refresh,
    updateClientConversationState,
    suspendNow,
    restartNow,
    disposeNow,
    registerObjectUrl,
  };
};
