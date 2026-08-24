import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from 'react';

import { chatDateLabel, chatTimeLabel, restorePrependScrollTop } from './model';
import { ChatPhotoThumbnail, type ChatPhotoOpenRequest } from './ChatPhotoThumbnail';
import type { ChatPhotoAccessDto, ChatTimelineMessage } from './types';

export interface ChatMessageListHandle {
  readonly capturePrependAnchor: () => {
    readonly scrollHeight: number;
    readonly scrollTop: number;
  };
  readonly restorePrependAnchor: (anchor: {
    readonly scrollHeight: number;
    readonly scrollTop: number;
  }) => void;
  readonly scrollToBottom: (behavior?: ScrollBehavior) => void;
  readonly isNearBottom: () => boolean;
  readonly measureVisibleIncoming: () => void;
}

export interface ChatMessageListProps {
  readonly messages: readonly ChatTimelineMessage[];
  readonly loadingOlder: boolean;
  readonly hasMoreBefore: boolean;
  readonly showNewMessagesButton: boolean;
  readonly loadPhotoAccess: (photoId: string, signal?: AbortSignal) => Promise<ChatPhotoAccessDto>;
  readonly onOpenPhoto: (request: ChatPhotoOpenRequest) => void;
  readonly onLoadOlder: () => void;
  readonly onRetry: (message: ChatTimelineMessage) => void;
  readonly onLatestVisibleIncomingSequenceChange: (sequence: number | null) => void;
  readonly onScrollToNewMessages: () => void;
}

const deliveryLabel = (message: ChatTimelineMessage): string => {
  if (!message.is_mine) {
    return '';
  }

  switch (message.delivery_status) {
    case 'sending':
      return 'Отправляется';
    case 'sent':
      return 'Отправлено';
    case 'read':
      return 'Прочитано';
    case 'failed':
      return 'Не отправлено';
  }
};

export const MessageList = forwardRef<ChatMessageListHandle, ChatMessageListProps>(
  (
    {
      messages,
      loadingOlder,
      hasMoreBefore,
      showNewMessagesButton,
      loadPhotoAccess,
      onOpenPhoto,
      onLoadOlder,
      onRetry,
      onLatestVisibleIncomingSequenceChange,
      onScrollToNewMessages,
    },
    forwardedRef,
  ): ReactNode => {
    const containerRef = useRef<HTMLDivElement>(null);
    const visibilityFrameRef = useRef<number | null>(null);

    const measureVisibleIncoming = useCallback((): void => {
      if (visibilityFrameRef.current !== null) {
        window.cancelAnimationFrame(visibilityFrameRef.current);
      }

      visibilityFrameRef.current = window.requestAnimationFrame(() => {
        visibilityFrameRef.current = null;
        const container = containerRef.current;
        if (container === null) {
          onLatestVisibleIncomingSequenceChange(null);
          return;
        }

        const bounds = container.getBoundingClientRect();
        let latest: number | null = null;
        container.querySelectorAll<HTMLElement>('[data-incoming-sequence]').forEach((element) => {
          const sequence = Number(element.dataset.incomingSequence);
          const rect = element.getBoundingClientRect();
          if (Number.isInteger(sequence) && rect.bottom > bounds.top && rect.top < bounds.bottom) {
            latest = latest === null ? sequence : Math.max(latest, sequence);
          }
        });
        onLatestVisibleIncomingSequenceChange(latest);
      });
    }, [onLatestVisibleIncomingSequenceChange]);

    useImperativeHandle(
      forwardedRef,
      () => ({
        capturePrependAnchor: () => ({
          scrollHeight: containerRef.current?.scrollHeight ?? 0,
          scrollTop: containerRef.current?.scrollTop ?? 0,
        }),
        restorePrependAnchor: (anchor) => {
          const container = containerRef.current;
          if (container !== null) {
            container.scrollTop = restorePrependScrollTop(
              anchor.scrollHeight,
              anchor.scrollTop,
              container.scrollHeight,
            );
            measureVisibleIncoming();
          }
        },
        scrollToBottom: (behavior = 'auto') => {
          containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior });
          measureVisibleIncoming();
        },
        isNearBottom: () => {
          const container = containerRef.current;
          return (
            container === null ||
            container.scrollHeight - container.scrollTop - container.clientHeight <= 72
          );
        },
        measureVisibleIncoming,
      }),
      [measureVisibleIncoming],
    );

    useEffect(() => {
      measureVisibleIncoming();
      return () => {
        if (visibilityFrameRef.current !== null) {
          window.cancelAnimationFrame(visibilityFrameRef.current);
        }
      };
    }, [measureVisibleIncoming, messages]);

    let previousDateLabel: string | null = null;

    return (
      <React.Fragment>
        <section className="chat-history-region" aria-label="История сообщений">
          <div
            ref={containerRef}
            className="chat-message-scroll"
            data-testid="chat-message-list"
            tabIndex={0}
            onScroll={(event) => {
              if (event.currentTarget.scrollTop <= 48 && hasMoreBefore && !loadingOlder) {
                onLoadOlder();
              }
              measureVisibleIncoming();
            }}
          >
            {loadingOlder ? (
              <p className="chat-history-loading" role="status">
                Загружаем предыдущие сообщения…
              </p>
            ) : null}
            <ol className="chat-message-list">
              {messages.map((message) => {
                const dateLabel = chatDateLabel(message.created_at);
                const showDate = dateLabel !== previousDateLabel;
                previousDateLabel = dateLabel;
                const incomingSequence =
                  !message.is_mine && message.sequence !== null ? message.sequence : undefined;

                return (
                  <li key={message.id} className="chat-message-entry">
                    {showDate ? (
                      <div className="chat-date-separator" data-testid="chat-date-separator">
                        <span>{dateLabel}</span>
                      </div>
                    ) : null}
                    <article
                      className={`chat-message-bubble ${message.is_mine ? 'is-mine' : 'is-theirs'} is-${message.delivery_status}`}
                      data-message-id={message.id}
                      {...(incomingSequence === undefined
                        ? {}
                        : { 'data-incoming-sequence': incomingSequence })}
                      aria-label={`${message.is_mine ? 'Ваше сообщение' : `Сообщение от ${message.sender_name}`}, ${chatTimeLabel(message.created_at)}`}
                    >
                      {message.photo === null ? null : (
                        <ChatPhotoThumbnail
                          photo={message.photo}
                          alt={message.text ?? `Фотография от ${message.sender_name}`}
                          loadAccess={loadPhotoAccess}
                          onOpen={onOpenPhoto}
                        />
                      )}
                      {message.text === null || message.text.length === 0 ? null : (
                        <p className="chat-message-text">{message.text}</p>
                      )}
                      <footer className="chat-message-meta">
                        <time dateTime={message.created_at}>
                          {chatTimeLabel(message.created_at)}
                        </time>
                        {message.is_mine ? <span>{deliveryLabel(message)}</span> : null}
                      </footer>
                      {message.delivery_status === 'failed' ? (
                        <div className="chat-message-failure">
                          {message.error_message === undefined ? null : (
                            <span role="alert">{message.error_message}</span>
                          )}
                          <button type="button" onClick={() => onRetry(message)}>
                            Повторить
                          </button>
                        </div>
                      ) : null}
                    </article>
                  </li>
                );
              })}
            </ol>
          </div>
          {showNewMessagesButton ? (
            <button
              className="chat-new-messages"
              data-testid="chat-new-messages"
              type="button"
              onClick={onScrollToNewMessages}
            >
              Новые сообщения
            </button>
          ) : null}
        </section>
      </React.Fragment>
    );
  },
);

MessageList.displayName = 'MessageList';
