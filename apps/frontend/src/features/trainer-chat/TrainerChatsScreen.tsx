import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { isTerminalChatAuthError } from '../chat/authError';
import { ConversationView } from '../chat/ConversationView';
import {
  applyChatInboxPatches,
  chatTimeLabel,
  chatUnreadBadge,
  sortChatInbox,
  type ChatInboxPatch,
} from '../chat/model';
import type {
  ChatConversationStateDto,
  ChatConversationSummaryDto,
  ChatInboxPageDto,
  ChatRealtimeClient,
  ChatRuntimeApi,
  ChatTrainerSessionDto,
} from '../chat/types';
import {
  recoverAuthorizedTrainerConversationSummary,
  TrainerSelectedConversationStore,
  type TrainerConversationSummaryPatch,
} from './selectedConversation';

export interface TrainerChatsScreenProps {
  readonly accountId: string;
  readonly routeConversationId: string | null;
  readonly session: ChatTrainerSessionDto;
  readonly api: ChatRuntimeApi;
  readonly realtime: ChatRealtimeClient;
  readonly online: boolean;
  readonly photoUploadsEnabled?: boolean;
  readonly onNavigateConversation: (conversationId: string) => void;
  readonly onBackToInbox: () => void;
  readonly onSessionExpired: () => void;
  readonly onSignOut?: () => void;
  readonly registerObjectUrl?: (url: string) => () => void;
}

type InboxLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'error'; readonly message: string };

type SelectedConversationState =
  | { readonly kind: 'none' }
  | { readonly kind: 'resolving'; readonly conversationId: string }
  | {
      readonly kind: 'ready';
      readonly conversationId: string;
      readonly summary: ChatConversationSummaryDto;
    }
  | { readonly kind: 'unavailable'; readonly conversationId: string }
  | { readonly kind: 'error'; readonly conversationId: string; readonly message: string };

const mergeInboxPage = (
  current: readonly ChatConversationSummaryDto[],
  page: ChatInboxPageDto,
  replace: boolean,
): readonly ChatConversationSummaryDto[] => {
  const byId = new Map<string, ChatConversationSummaryDto>();
  if (!replace) {
    current.forEach((conversation) => byId.set(conversation.id, conversation));
  }
  page.items.forEach((conversation) => byId.set(conversation.id, conversation));
  return sortChatInbox([...byId.values()]);
};

const inboxPreview = (conversation: ChatConversationSummaryDto): string => {
  if (conversation.last_message === null) {
    return 'Новый диалог';
  }

  return conversation.last_message.kind === 'photo' ? '📷 Фото' : conversation.last_message.preview;
};

const conversationHref = (conversationId: string): string =>
  `/trainer/chats/${encodeURIComponent(conversationId)}`;

export const TrainerChatsScreen = ({
  accountId,
  routeConversationId,
  session,
  api,
  realtime,
  online,
  photoUploadsEnabled = false,
  onNavigateConversation,
  onBackToInbox,
  onSessionExpired,
  onSignOut,
  registerObjectUrl,
}: TrainerChatsScreenProps): ReactNode => {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [items, setItems] = useState<readonly ChatConversationSummaryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<InboxLoadState>({ kind: 'loading' });
  const [selectedState, setSelectedState] = useState<SelectedConversationState>(() =>
    routeConversationId === null
      ? { kind: 'none' }
      : { kind: 'resolving', conversationId: routeConversationId },
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const requestVersionRef = useRef(0);
  const inboxScrollRef = useRef<HTMLDivElement>(null);
  const nextCursorRef = useRef<string | null>(nextCursor);
  const loadingMoreRef = useRef(loadingMore);
  const itemsRef = useRef<readonly ChatConversationSummaryDto[]>(items);
  const inboxPatchVersionRef = useRef(0);
  const inboxPatchesRef = useRef(new Map<string, ChatInboxPatch>());
  const selectedStoreRef = useRef(new TrainerSelectedConversationStore());
  const selectedRecoveryControllerRef = useRef<AbortController | null>(null);
  const selectedRecoveryVersionRef = useRef(0);
  const routeConversationIdRef = useRef(routeConversationId);

  nextCursorRef.current = nextCursor;
  loadingMoreRef.current = loadingMore;
  itemsRef.current = items;
  routeConversationIdRef.current = routeConversationId;

  const rememberInboxSummaries = useCallback(
    (summaries: readonly ChatConversationSummaryDto[]): void => {
      selectedStoreRef.current.remember(summaries);
      const selectedId = routeConversationIdRef.current;
      if (selectedId === null) {
        return;
      }

      const selected = selectedStoreRef.current.get(selectedId);
      if (selected !== null) {
        selectedRecoveryControllerRef.current?.abort();
        selectedRecoveryControllerRef.current = null;
        selectedRecoveryVersionRef.current += 1;
        setSelectedState({ kind: 'ready', conversationId: selectedId, summary: selected });
      }
    },
    [],
  );

  const patchSelectedSummary = useCallback(
    (conversationId: string, patch: TrainerConversationSummaryPatch): void => {
      const selected = selectedStoreRef.current.applyPatch(conversationId, patch);
      if (selected !== null && routeConversationIdRef.current === conversationId) {
        setSelectedState({ kind: 'ready', conversationId, summary: selected });
      }
    },
    [],
  );

  const loadInbox = useCallback(
    (replace: boolean): void => {
      if (!replace && (loadingMoreRef.current || nextCursorRef.current === null)) {
        return;
      }

      controllerRef.current?.abort();
      const controller = new AbortController();
      const version = ++requestVersionRef.current;
      const patchVersion = inboxPatchVersionRef.current;
      controllerRef.current = controller;
      if (replace) {
        setLoadState({ kind: 'loading' });
      } else {
        loadingMoreRef.current = true;
        setLoadingMore(true);
      }

      void api
        .getInbox({
          filter,
          limit: 30,
          ...(replace || nextCursorRef.current === null ? {} : { cursor: nextCursorRef.current }),
          ...(searchQuery === null ? {} : { query: searchQuery }),
          signal: controller.signal,
        })
        .then((page) => {
          if (controller.signal.aborted || requestVersionRef.current !== version) {
            return;
          }
          const merged = applyChatInboxPatches(
            mergeInboxPage(itemsRef.current, page, replace),
            [...inboxPatchesRef.current.values()],
            patchVersion,
          );
          itemsRef.current = merged;
          rememberInboxSummaries(merged);
          setItems(merged);
          setNextCursor(page.next_cursor);
          nextCursorRef.current = page.next_cursor;
          setLoadState({ kind: 'ready' });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || requestVersionRef.current !== version) {
            return;
          }
          if (isTerminalChatAuthError(error)) {
            onSessionExpired();
            return;
          }
          setLoadState({
            kind: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Не удалось загрузить диалоги. Попробуйте ещё раз.',
          });
        })
        .finally(() => {
          if (controllerRef.current === controller) {
            controllerRef.current = null;
          }
          setLoadingMore(false);
          loadingMoreRef.current = false;
        });
    },
    [api, filter, onSessionExpired, rememberInboxSummaries, searchQuery],
  );

  useEffect(() => {
    const normalized = searchInput.trim().normalize('NFC');
    const timer = window.setTimeout(() => {
      setSearchQuery(normalized.length >= 2 ? normalized : null);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    loadInbox(true);
    return () => {
      controllerRef.current?.abort();
      requestVersionRef.current += 1;
    };
  }, [loadInbox]);

  const recoverSelectedConversation = useCallback(
    (conversationId: string): void => {
      const cached = selectedStoreRef.current.get(conversationId);
      if (cached !== null) {
        setSelectedState({ kind: 'ready', conversationId, summary: cached });
        return;
      }

      selectedRecoveryControllerRef.current?.abort();
      const controller = new AbortController();
      const version = ++selectedRecoveryVersionRef.current;
      selectedRecoveryControllerRef.current = controller;
      setSelectedState({ kind: 'resolving', conversationId });

      void recoverAuthorizedTrainerConversationSummary(
        api.getConversationSummary,
        conversationId,
        controller.signal,
      )
        .then((summary) => {
          if (
            controller.signal.aborted ||
            selectedRecoveryVersionRef.current !== version ||
            routeConversationIdRef.current !== conversationId
          ) {
            return;
          }

          if (summary === null) {
            setSelectedState({ kind: 'unavailable', conversationId });
            return;
          }

          selectedStoreRef.current.remember([summary]);
          const pendingPatch = inboxPatchesRef.current.get(conversationId);
          const exactSummary =
            pendingPatch === undefined
              ? summary
              : (selectedStoreRef.current.applyPatch(conversationId, {
                  unreadCount: pendingPatch.unreadCount,
                  ...(pendingPatch.lastMessage === undefined
                    ? {}
                    : { lastMessage: pendingPatch.lastMessage }),
                }) ?? summary);
          setSelectedState({ kind: 'ready', conversationId, summary: exactSummary });
        })
        .catch((error: unknown) => {
          if (
            controller.signal.aborted ||
            selectedRecoveryVersionRef.current !== version ||
            routeConversationIdRef.current !== conversationId
          ) {
            return;
          }

          if (isTerminalChatAuthError(error)) {
            onSessionExpired();
            return;
          }

          setSelectedState({
            kind: 'error',
            conversationId,
            message:
              error instanceof Error
                ? error.message
                : 'Не удалось проверить доступ к диалогу. Попробуйте ещё раз.',
          });
        })
        .finally(() => {
          if (selectedRecoveryControllerRef.current === controller) {
            selectedRecoveryControllerRef.current = null;
          }
        });
    },
    [api.getConversationSummary, onSessionExpired],
  );

  useEffect(() => {
    selectedRecoveryControllerRef.current?.abort();
    selectedRecoveryControllerRef.current = null;
    selectedRecoveryVersionRef.current += 1;

    if (routeConversationId === null) {
      setSelectedState({ kind: 'none' });
      return undefined;
    }

    recoverSelectedConversation(routeConversationId);
    return () => {
      selectedRecoveryControllerRef.current?.abort();
      selectedRecoveryControllerRef.current = null;
      selectedRecoveryVersionRef.current += 1;
    };
  }, [recoverSelectedConversation, routeConversationId]);

  useEffect(
    () =>
      realtime.subscribe((event) => {
        if (event.type === 'session:invalidated') {
          onSessionExpired();
          return;
        }

        if (event.type === 'read:updated') {
          if (event.reader_role === 'trainer') {
            loadInbox(true);
          }
          return;
        }

        if (event.type !== 'conversation:updated') {
          return;
        }

        const priorPatch = inboxPatchesRef.current.get(event.conversation_id);
        const patch: ChatInboxPatch = {
          ...priorPatch,
          conversationId: event.conversation_id,
          version: ++inboxPatchVersionRef.current,
          unreadCount: event.unread_count,
          lastMessage: event.last_message,
        };
        inboxPatchesRef.current.set(event.conversation_id, patch);
        patchSelectedSummary(event.conversation_id, {
          unreadCount: event.unread_count,
          lastMessage: event.last_message,
        });

        if (searchQuery !== null || filter === 'unread') {
          loadInbox(true);
          return;
        }

        const found = itemsRef.current.some(({ id }) => id === event.conversation_id);
        if (found) {
          setItems((current) => {
            const sorted = applyChatInboxPatches(current, [patch], patch.version - 1);
            itemsRef.current = sorted;
            return sorted;
          });
        } else {
          loadInbox(true);
        }
      }),
    [filter, loadInbox, onSessionExpired, patchSelectedSummary, realtime, searchQuery],
  );

  const selectedConversation =
    selectedState.kind === 'ready' && selectedState.conversationId === routeConversationId
      ? selectedState.summary
      : null;
  const searchNeedsMoreCharacters = searchInput.trim().length === 1;

  const navigate = (event: MouseEvent<HTMLAnchorElement>, conversationId: string): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    onNavigateConversation(conversationId);
  };

  const updateSelectedUnread = useCallback(
    (state: ChatConversationStateDto): void => {
      if (routeConversationId === null) {
        return;
      }
      const priorPatch = inboxPatchesRef.current.get(routeConversationId);
      const patch: ChatInboxPatch = {
        ...priorPatch,
        conversationId: routeConversationId,
        version: ++inboxPatchVersionRef.current,
        unreadCount: state.unread_count,
      };
      inboxPatchesRef.current.set(routeConversationId, patch);
      patchSelectedSummary(routeConversationId, { unreadCount: state.unread_count });
      setItems((current) => {
        const updated = applyChatInboxPatches(current, [patch], patch.version - 1);
        itemsRef.current = updated;
        return updated;
      });
    },
    [patchSelectedSummary, routeConversationId],
  );

  return (
    <React.Fragment>
      <main
        className={`trainer-chat-shell ${routeConversationId === null ? 'shows-inbox' : 'shows-conversation'}`}
        data-testid="trainer-chat-screen"
      >
        <div className="trainer-chat-layout">
          <section className="trainer-inbox" aria-labelledby="trainer-inbox-title">
            <header className="trainer-inbox-header">
              <div>
                <p>ТРЕНЕР KINETRA</p>
                <h1 id="trainer-inbox-title">Диалоги</h1>
              </div>
              {onSignOut === undefined ? null : (
                <button type="button" onClick={onSignOut}>
                  Выйти
                </button>
              )}
            </header>

            <label className="trainer-inbox-search">
              <span className="visually-hidden">Поиск клиента</span>
              <input
                data-testid="trainer-chat-search"
                type="search"
                value={searchInput}
                maxLength={100}
                placeholder="Найти клиента"
                onChange={(event) => setSearchInput(event.currentTarget.value)}
              />
            </label>
            {searchNeedsMoreCharacters ? (
              <p className="trainer-inbox-search-hint" role="status">
                Введите минимум 2 символа.
              </p>
            ) : null}

            <div className="trainer-inbox-filters" aria-label="Фильтр диалогов">
              <button
                type="button"
                aria-pressed={filter === 'all'}
                onClick={() => setFilter('all')}
              >
                Все
              </button>
              <button
                type="button"
                aria-pressed={filter === 'unread'}
                onClick={() => setFilter('unread')}
              >
                Непрочитанные
              </button>
            </div>

            <div ref={inboxScrollRef} className="trainer-inbox-scroll">
              {loadState.kind === 'loading' ? <p role="status">Загружаем диалоги…</p> : null}
              {loadState.kind === 'error' ? (
                <div role="alert">
                  <p>{loadState.message}</p>
                  <button type="button" onClick={() => loadInbox(true)}>
                    Повторить
                  </button>
                </div>
              ) : null}
              {loadState.kind === 'ready' && items.length === 0 ? (
                <p className="trainer-inbox-empty">Диалогов пока нет.</p>
              ) : null}
              <ol className="trainer-inbox-list">
                {items.map((conversation) => {
                  const active = conversation.id === routeConversationId;
                  const badge = chatUnreadBadge(conversation.unread_count);
                  return (
                    <li key={conversation.id}>
                      <a
                        className={`trainer-conversation-row${active ? ' is-active' : ''}`}
                        data-testid="trainer-conversation-row"
                        href={conversationHref(conversation.id)}
                        aria-current={active ? 'page' : undefined}
                        onClick={(event) => navigate(event, conversation.id)}
                      >
                        <span className="trainer-conversation-avatar" aria-hidden="true">
                          {conversation.client.avatar_url === null
                            ? Array.from(conversation.client.display_name)[0]?.toLocaleUpperCase(
                                'ru-RU',
                              )
                            : null}
                          {conversation.client.avatar_url === null ? null : (
                            <img src={conversation.client.avatar_url} alt="" />
                          )}
                        </span>
                        <span className="trainer-conversation-copy">
                          <strong>{conversation.client.display_name}</strong>
                          <small>{conversation.client.secondary_label}</small>
                          <span>{inboxPreview(conversation)}</span>
                        </span>
                        <span className="trainer-conversation-meta">
                          {conversation.last_message === null ? null : (
                            <time dateTime={conversation.last_message.created_at}>
                              {chatTimeLabel(conversation.last_message.created_at)}
                            </time>
                          )}
                          {badge === null ? null : (
                            <span
                              className="trainer-conversation-badge"
                              aria-label={`${badge} непрочитанных`}
                            >
                              {badge}
                            </span>
                          )}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ol>
              {nextCursor === null || loadState.kind !== 'ready' ? null : (
                <button
                  className="trainer-inbox-more"
                  data-testid="trainer-inbox-more"
                  type="button"
                  disabled={loadingMore}
                  onClick={() => loadInbox(false)}
                >
                  {loadingMore ? 'Загружаем…' : 'Показать ещё'}
                </button>
              )}
            </div>
          </section>

          <section className="trainer-conversation-pane" aria-label="Выбранный диалог">
            {routeConversationId === null ? (
              <div
                className="trainer-conversation-placeholder"
                data-testid="trainer-chat-placeholder"
              >
                <p>Выберите диалог</p>
              </div>
            ) : selectedConversation !== null ? (
              <ConversationView
                key={routeConversationId}
                accountId={accountId}
                conversationId={routeConversationId}
                role="trainer"
                ownDisplayName={session.profile.display_name}
                counterpart={selectedConversation.client}
                api={api}
                realtime={realtime}
                online={online}
                photoUploadsEnabled={photoUploadsEnabled}
                emptyMessage="В диалоге пока нет сообщений."
                embedded
                backLabel="К диалогам"
                headingLevel="h2"
                onBack={onBackToInbox}
                onSessionExpired={onSessionExpired}
                onConversationStateChange={updateSelectedUnread}
                {...(registerObjectUrl === undefined ? {} : { registerObjectUrl })}
              />
            ) : selectedState.kind === 'unavailable' &&
              selectedState.conversationId === routeConversationId ? (
              <div
                className="trainer-conversation-placeholder"
                data-testid="trainer-chat-detail-unavailable"
                role="alert"
              >
                <p>Диалог не найден или больше не назначен этому тренеру.</p>
                <button type="button" onClick={onBackToInbox}>
                  К диалогам
                </button>
              </div>
            ) : selectedState.kind === 'error' &&
              selectedState.conversationId === routeConversationId ? (
              <div
                className="trainer-conversation-placeholder"
                data-testid="trainer-chat-detail-error"
                role="alert"
              >
                <p>{selectedState.message}</p>
                <button
                  type="button"
                  onClick={() => recoverSelectedConversation(routeConversationId)}
                >
                  Повторить
                </button>
                <button type="button" onClick={onBackToInbox}>
                  К диалогам
                </button>
              </div>
            ) : (
              <div
                className="trainer-conversation-placeholder"
                data-testid="trainer-chat-detail-resolving"
                role="status"
              >
                <p>Проверяем доступ и загружаем данные клиента…</p>
              </div>
            )}
          </section>
        </div>
      </main>
    </React.Fragment>
  );
};
