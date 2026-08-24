import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { isTerminalChatAuthError } from './authError';
import { ChatComposer } from './ChatComposer';
import {
  createComposerAcknowledgement,
  type ChatComposerAcknowledgement,
} from './composerAcknowledgement';
import type { ChatPhotoOpenRequest } from './ChatPhotoThumbnail';
import { MessageList, type ChatMessageListHandle } from './MessageList';
import {
  applyConversationState,
  advanceChatRestSequence,
  createOptimisticMessage,
  markTimelineMessageFailed,
  markTimelineMessageSending,
  mergeTimelineMessages,
  nextChatReadSequence,
  reconcileTimelineReadState,
} from './model';
import { PhotoViewer } from './PhotoViewer';
import { ChatReadAcknowledgementLifecycle } from './readAcknowledgementLifecycle';
import type {
  ChatAccountRole,
  ChatConnectionState,
  ChatConversationStateDto,
  ChatMessageDto,
  ChatMessageRequest,
  ChatPersonDto,
  ChatRealtimeClient,
  ChatRuntimeApi,
  ChatTimelineMessage,
  ChatUploadPhotoInput,
} from './types';

type ConversationLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'error'; readonly message: string };

export interface ConversationViewProps {
  readonly accountId: string;
  readonly conversationId: string;
  readonly role: ChatAccountRole;
  readonly ownDisplayName: string;
  readonly counterpart: ChatPersonDto;
  readonly api: ChatRuntimeApi;
  readonly realtime: ChatRealtimeClient;
  readonly online: boolean;
  readonly photoUploadsEnabled?: boolean;
  readonly emptyMessage?: string;
  readonly embedded?: boolean;
  readonly backLabel?: string;
  readonly headingLevel?: 'h1' | 'h2';
  readonly onBack: () => void;
  readonly onSessionExpired: () => void;
  readonly onConversationStateChange?: (state: ChatConversationStateDto) => void;
  readonly registerObjectUrl?: (url: string) => () => void;
}

const initialConversationState = (): ChatConversationStateDto => ({
  last_message_sequence: 0,
  own_last_read_sequence: 0,
  counterpart_last_read_sequence: 0,
  unread_count: 0,
});

const messageForError = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const initials = (name: string): string =>
  name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0]?.toLocaleUpperCase('ru-RU') ?? '')
    .join('') || 'K';

const connectionLabel = (
  online: boolean,
  state: ChatConnectionState,
  historyReady: boolean,
): string => {
  if (!online || state === 'offline') {
    return 'Нет сети';
  }

  return state === 'connected' && historyReady ? 'Подключено' : 'Переподключаемся…';
};

type OpenPhotoState = ChatPhotoOpenRequest;

export const ConversationView = ({
  accountId,
  conversationId,
  role,
  ownDisplayName,
  counterpart,
  api,
  realtime,
  online,
  photoUploadsEnabled = false,
  emptyMessage = 'Здесь можно задать тренеру вопрос о тренировках.',
  embedded = false,
  backLabel = 'Назад',
  headingLevel = 'h1',
  onBack,
  onSessionExpired,
  onConversationStateChange,
  registerObjectUrl,
}: ConversationViewProps): ReactNode => {
  const [loadState, setLoadState] = useState<ConversationLoadState>({ kind: 'loading' });
  const [messages, setMessages] = useState<readonly ChatTimelineMessage[]>([]);
  const [conversationState, setConversationState] =
    useState<ChatConversationStateDto>(initialConversationState);
  const [beforeSequence, setBeforeSequence] = useState<number | null>(null);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showNewMessagesButton, setShowNewMessagesButton] = useState(false);
  const [latestVisibleIncoming, setLatestVisibleIncoming] = useState<number | null>(null);
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'visible',
  );
  const [connectionState, setConnectionState] = useState<ChatConnectionState>(() =>
    realtime.getConnectionState(),
  );
  const [openPhoto, setOpenPhoto] = useState<OpenPhotoState | null>(null);
  const [composerAcknowledgement, setComposerAcknowledgement] =
    useState<ChatComposerAcknowledgement | null>(null);
  const listRef = useRef<ChatMessageListHandle>(null);
  const messagesRef = useRef<readonly ChatTimelineMessage[]>(messages);
  const conversationStateRef = useRef(conversationState);
  const initialControllerRef = useRef<AbortController | null>(null);
  const historyRequestVersionRef = useRef(0);
  const restSequenceRef = useRef(0);
  const readLifecycleRef = useRef<ChatReadAcknowledgementLifecycle | null>(null);
  const composerAcknowledgementNonceRef = useRef(0);

  messagesRef.current = messages;
  conversationStateRef.current = conversationState;

  const updateConversationState = useCallback(
    (next: ChatConversationStateDto): void => {
      readLifecycleRef.current?.observeAcknowledged(next.own_last_read_sequence);
      setConversationState((current) => {
        const merged = applyConversationState(current, next);
        conversationStateRef.current = merged;
        onConversationStateChange?.(merged);
        return merged;
      });
    },
    [onConversationStateChange],
  );

  const loadInitial = useCallback((): void => {
    initialControllerRef.current?.abort();
    const controller = new AbortController();
    const version = ++historyRequestVersionRef.current;
    initialControllerRef.current = controller;
    setLoadState({ kind: 'loading' });

    void api
      .getMessages(conversationId, { limit: 30, signal: controller.signal })
      .then(async (page) => {
        if (controller.signal.aborted || historyRequestVersionRef.current !== version) {
          return;
        }

        const timeline = mergeTimelineMessages(
          messagesRef.current,
          page.messages,
          page.conversation_state.counterpart_last_read_sequence,
        );
        setMessages(timeline);
        messagesRef.current = timeline;
        updateConversationState(page.conversation_state);
        setBeforeSequence(page.next_before_sequence);
        setHasMoreBefore(page.has_more_before);

        let afterSequence = advanceChatRestSequence(0, page.messages);
        restSequenceRef.current = afterSequence;
        let hasMoreAfter = true;

        while (hasMoreAfter) {
          const delta = await api.getMessages(conversationId, {
            after_sequence: afterSequence,
            limit: 50,
            signal: controller.signal,
          });

          if (controller.signal.aborted || historyRequestVersionRef.current !== version) {
            return;
          }

          const merged = mergeTimelineMessages(
            messagesRef.current,
            delta.messages,
            delta.conversation_state.counterpart_last_read_sequence,
          );
          messagesRef.current = merged;
          setMessages(merged);
          updateConversationState(delta.conversation_state);
          hasMoreAfter = delta.has_more_after;
          const nextSequence = advanceChatRestSequence(afterSequence, delta.messages);

          if (
            hasMoreAfter &&
            (nextSequence <= afterSequence || delta.next_after_sequence !== nextSequence)
          ) {
            throw new Error('Сервер вернул некорректный курсор синхронизации.');
          }

          afterSequence = nextSequence;
          restSequenceRef.current = Math.max(restSequenceRef.current, afterSequence);
        }

        setLoadState({ kind: 'ready' });
        realtime.sync(conversationId, afterSequence);
        window.requestAnimationFrame(() => listRef.current?.scrollToBottom());
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || historyRequestVersionRef.current !== version) {
          return;
        }

        if (isTerminalChatAuthError(error)) {
          onSessionExpired();
          return;
        }

        setLoadState({
          kind: 'error',
          message: messageForError(
            error,
            'Не удалось загрузить сообщения. Проверьте соединение и попробуйте ещё раз.',
          ),
        });
      })
      .finally(() => {
        if (initialControllerRef.current === controller) {
          initialControllerRef.current = null;
        }
      });
  }, [api, conversationId, onSessionExpired, realtime, updateConversationState]);

  useEffect(() => {
    messagesRef.current = [];
    conversationStateRef.current = initialConversationState();
    restSequenceRef.current = 0;
    setMessages([]);
    setConversationState(conversationStateRef.current);
    setBeforeSequence(null);
    setHasMoreBefore(false);
    setShowNewMessagesButton(false);
    loadInitial();
    return () => {
      initialControllerRef.current?.abort();
      initialControllerRef.current = null;
      historyRequestVersionRef.current += 1;
    };
  }, [conversationId, loadInitial]);

  useEffect(() => {
    const lifecycle = new ChatReadAcknowledgementLifecycle(
      {
        markRead: (throughSequence, signal) =>
          api.markRead(conversationId, throughSequence, signal),
        onAcknowledged: updateConversationState,
        onTerminalError: onSessionExpired,
        isTerminalError: isTerminalChatAuthError,
      },
      conversationStateRef.current.own_last_read_sequence,
    );
    readLifecycleRef.current = lifecycle;

    return () => {
      lifecycle.dispose();
      if (readLifecycleRef.current === lifecycle) {
        readLifecycleRef.current = null;
      }
    };
  }, [api, conversationId, onSessionExpired, updateConversationState]);

  const catchUpAfterReconnect = useCallback(async (): Promise<void> => {
    let afterSequence = restSequenceRef.current;
    let hasMore = true;

    while (hasMore) {
      const page = await api.getMessages(conversationId, {
        after_sequence: afterSequence,
        limit: 50,
      });
      const merged = mergeTimelineMessages(
        messagesRef.current,
        page.messages,
        page.conversation_state.counterpart_last_read_sequence,
      );
      messagesRef.current = merged;
      setMessages(merged);
      updateConversationState(page.conversation_state);
      hasMore = page.has_more_after;
      const next = advanceChatRestSequence(afterSequence, page.messages);
      if (hasMore && (next <= afterSequence || page.next_after_sequence !== next)) {
        throw new Error('Сервер вернул некорректный курсор синхронизации.');
      }
      afterSequence = next;
      restSequenceRef.current = Math.max(restSequenceRef.current, afterSequence);
    }

    realtime.sync(conversationId, restSequenceRef.current);
  }, [api, conversationId, realtime, updateConversationState]);

  useEffect(
    () =>
      realtime.subscribe((event) => {
        if (event.type === 'connection') {
          if (event.state !== 'connected') {
            setConnectionState(event.state);
            return;
          }

          setConnectionState('reconnecting');
          void catchUpAfterReconnect()
            .then(() => {
              setConnectionState('connected');
              readLifecycleRef.current?.retryNow();
            })
            .catch((error: unknown) => {
              if (isTerminalChatAuthError(error)) {
                onSessionExpired();
              } else {
                setConnectionState(online ? 'reconnecting' : 'offline');
              }
            });
          return;
        }

        if (event.type === 'session:invalidated') {
          onSessionExpired();
          return;
        }

        if (event.type === 'message:new' && event.message.conversation_id === conversationId) {
          const wasNearBottom = listRef.current?.isNearBottom() ?? true;
          const alreadyPresent = messagesRef.current.some(
            (message) =>
              message.id === event.message.id ||
              message.client_message_id === event.message.client_message_id,
          );
          const reconciledOwnOptimistic = event.message.is_mine
            ? messagesRef.current.find(
                (message) =>
                  message.client_message_id === event.message.client_message_id &&
                  message.sequence === null &&
                  message.pending_request !== undefined,
              )
            : undefined;
          const merged = mergeTimelineMessages(
            messagesRef.current,
            [event.message],
            conversationStateRef.current.counterpart_last_read_sequence,
          );
          messagesRef.current = merged;
          setMessages(merged);
          setConversationState((current) => ({
            ...current,
            last_message_sequence: Math.max(current.last_message_sequence, event.message.sequence),
            unread_count:
              event.message.is_mine || alreadyPresent
                ? current.unread_count
                : current.unread_count + 1,
          }));
          if (reconciledOwnOptimistic?.pending_request !== undefined) {
            const acknowledgement = createComposerAcknowledgement(
              event.message,
              reconciledOwnOptimistic.pending_request,
              ++composerAcknowledgementNonceRef.current,
            );
            if (acknowledgement !== null) {
              setComposerAcknowledgement(acknowledgement);
            }
          }

          if (wasNearBottom) {
            window.requestAnimationFrame(() => listRef.current?.scrollToBottom('smooth'));
          } else {
            setShowNewMessagesButton(true);
          }
          return;
        }

        if (
          event.type === 'read:updated' &&
          event.conversation_id === conversationId &&
          event.reader_role !== role
        ) {
          setConversationState((current) => {
            const counterpartLastReadSequence = Math.max(
              current.counterpart_last_read_sequence,
              event.through_sequence,
            );
            const next = {
              ...current,
              counterpart_last_read_sequence: counterpartLastReadSequence,
            };
            setMessages((currentMessages) => {
              const reconciled = reconcileTimelineReadState(
                currentMessages,
                counterpartLastReadSequence,
              );
              messagesRef.current = reconciled;
              return reconciled;
            });
            onConversationStateChange?.(next);
            return next;
          });
        }
      }),
    [
      catchUpAfterReconnect,
      conversationId,
      onConversationStateChange,
      onSessionExpired,
      online,
      realtime,
      role,
    ],
  );

  useEffect(() => {
    const handleVisibility = (): void => {
      const visible = document.visibilityState === 'visible';
      setDocumentVisible(visible);
      if (visible) {
        listRef.current?.measureVisibleIncoming();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  useEffect(() => {
    if (online) {
      readLifecycleRef.current?.retryNow();
    }
  }, [online]);

  useEffect(() => {
    const throughSequence = nextChatReadSequence({
      conversationOpen: true,
      documentVisible,
      pageLoaded: loadState.kind === 'ready',
      latestVisibleIncomingSequence: latestVisibleIncoming,
      ownLastReadSequence: conversationState.own_last_read_sequence,
    });
    if (throughSequence === null) {
      return;
    }

    readLifecycleRef.current?.queue(throughSequence);
  }, [
    conversationState.own_last_read_sequence,
    documentVisible,
    latestVisibleIncoming,
    loadState.kind,
  ]);

  const loadOlder = (): void => {
    if (loadingOlder || !hasMoreBefore || beforeSequence === null) {
      return;
    }

    const anchor = listRef.current?.capturePrependAnchor();
    const controller = new AbortController();
    setLoadingOlder(true);
    void api
      .getMessages(conversationId, {
        before_sequence: beforeSequence,
        limit: 30,
        signal: controller.signal,
      })
      .then((page) => {
        const merged = mergeTimelineMessages(
          messagesRef.current,
          page.messages,
          page.conversation_state.counterpart_last_read_sequence,
        );
        messagesRef.current = merged;
        setMessages(merged);
        updateConversationState(page.conversation_state);
        setBeforeSequence(page.next_before_sequence);
        setHasMoreBefore(page.has_more_before);
        if (anchor !== undefined) {
          window.requestAnimationFrame(() => listRef.current?.restorePrependAnchor(anchor));
        }
      })
      .catch((error: unknown) => {
        if (isTerminalChatAuthError(error)) {
          onSessionExpired();
        }
      })
      .finally(() => setLoadingOlder(false));
  };

  const sendMessage = async (request: ChatMessageRequest): Promise<ChatMessageDto> => {
    const optimistic = createOptimisticMessage(conversationId, role, ownDisplayName, request);
    const withOptimistic = mergeTimelineMessages(messagesRef.current, [optimistic]);
    messagesRef.current = withOptimistic;
    setMessages(withOptimistic);
    window.requestAnimationFrame(() => listRef.current?.scrollToBottom('smooth'));

    try {
      const canonical = await api.sendMessage(conversationId, request);
      const merged = mergeTimelineMessages(
        messagesRef.current,
        [canonical],
        conversationStateRef.current.counterpart_last_read_sequence,
      );
      messagesRef.current = merged;
      setMessages(merged);
      setConversationState((current) => ({
        ...current,
        last_message_sequence: Math.max(current.last_message_sequence, canonical.sequence),
      }));
      return canonical;
    } catch (error) {
      const failed = markTimelineMessageFailed(
        messagesRef.current,
        request.client_message_id,
        messageForError(error, 'Не удалось отправить сообщение.'),
      );
      messagesRef.current = failed;
      setMessages(failed);
      if (isTerminalChatAuthError(error)) {
        onSessionExpired();
      }
      throw error;
    }
  };

  const retryMessage = (message: ChatTimelineMessage): void => {
    if (message.pending_request === undefined || message.delivery_status !== 'failed') {
      return;
    }

    const pendingRequest = message.pending_request;
    const sending = markTimelineMessageSending(messagesRef.current, message.client_message_id);
    messagesRef.current = sending;
    setMessages(sending);
    void api
      .sendMessage(conversationId, pendingRequest)
      .then((canonical) => {
        const merged = mergeTimelineMessages(
          messagesRef.current,
          [canonical],
          conversationStateRef.current.counterpart_last_read_sequence,
        );
        messagesRef.current = merged;
        setMessages(merged);
        const acknowledgement = createComposerAcknowledgement(
          canonical,
          pendingRequest,
          ++composerAcknowledgementNonceRef.current,
        );
        if (acknowledgement !== null) {
          setComposerAcknowledgement(acknowledgement);
        }
      })
      .catch((error: unknown) => {
        const failed = markTimelineMessageFailed(
          messagesRef.current,
          message.client_message_id,
          messageForError(error, 'Не удалось повторить отправку.'),
        );
        messagesRef.current = failed;
        setMessages(failed);
        if (isTerminalChatAuthError(error)) {
          onSessionExpired();
        }
      });
  };

  const uploadPhoto = (input: ChatUploadPhotoInput) => api.uploadPhoto(conversationId, input);
  const avatar = counterpart.avatar_url;
  const statusLabel = connectionLabel(online, connectionState, loadState.kind === 'ready');

  const conversationContent = (
    <React.Fragment>
      <section className="chat-conversation-panel" aria-labelledby="chat-conversation-title">
        <header className="chat-conversation-header">
          <button
            className="chat-back-button"
            data-testid="chat-back"
            type="button"
            onClick={onBack}
          >
            {backLabel}
          </button>
          <div className="chat-counterpart-avatar" aria-hidden="true">
            {avatar === null ? initials(counterpart.display_name) : <img src={avatar} alt="" />}
          </div>
          <div className="chat-counterpart-copy">
            {headingLevel === 'h1' ? (
              <h1 id="chat-conversation-title">{counterpart.display_name}</h1>
            ) : (
              <h2 id="chat-conversation-title">{counterpart.display_name}</h2>
            )}
            <span className="chat-connection-status" data-testid="chat-connection-status">
              {statusLabel}
            </span>
          </div>
        </header>

        {!online ? (
          <p className="chat-network-banner" role="status">
            Нет сети. История доступна, отправка временно отключена.
          </p>
        ) : null}

        {loadState.kind === 'loading' ? (
          <div className="chat-conversation-loading" role="status">
            Загружаем сообщения…
          </div>
        ) : null}
        {loadState.kind === 'error' ? (
          <div className="chat-conversation-error" role="alert">
            <p>{loadState.message}</p>
            <button type="button" onClick={loadInitial}>
              Повторить
            </button>
          </div>
        ) : null}
        {loadState.kind === 'ready' && messages.length === 0 ? (
          <div className="chat-empty-state" data-testid="chat-empty-state">
            <p>{emptyMessage}</p>
          </div>
        ) : null}
        {loadState.kind === 'ready' ? (
          <MessageList
            ref={listRef}
            messages={messages}
            loadingOlder={loadingOlder}
            hasMoreBefore={hasMoreBefore}
            showNewMessagesButton={showNewMessagesButton}
            loadPhotoAccess={api.getPhotoAccess}
            onOpenPhoto={setOpenPhoto}
            onLoadOlder={loadOlder}
            onRetry={retryMessage}
            onLatestVisibleIncomingSequenceChange={setLatestVisibleIncoming}
            onScrollToNewMessages={() => {
              setShowNewMessagesButton(false);
              listRef.current?.scrollToBottom('smooth');
            }}
          />
        ) : null}

        <ChatComposer
          accountId={accountId}
          conversationId={conversationId}
          online={online}
          disabled={loadState.kind !== 'ready'}
          photoUploadsEnabled={photoUploadsEnabled}
          acknowledgement={composerAcknowledgement}
          uploadPhoto={uploadPhoto}
          getPhotoStatus={api.getPhotoStatus}
          onSend={sendMessage}
          {...(registerObjectUrl === undefined ? {} : { registerObjectUrl })}
        />
      </section>
      <PhotoViewer
        open={openPhoto !== null}
        photo={openPhoto?.photo ?? null}
        alt={openPhoto?.alt ?? 'Фотография в чате'}
        initialAccess={openPhoto?.access ?? null}
        returnFocusElement={openPhoto?.trigger ?? null}
        loadAccess={api.getPhotoAccess}
        onClose={() => setOpenPhoto(null)}
      />
    </React.Fragment>
  );

  return embedded ? (
    <div
      className="chat-conversation-shell"
      data-testid="chat-conversation-screen"
      role="region"
      aria-labelledby="chat-conversation-title"
    >
      {conversationContent}
    </div>
  ) : (
    <main className="chat-conversation-shell" data-testid="chat-conversation-screen">
      {conversationContent}
    </main>
  );
};
