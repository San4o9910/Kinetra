import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { isTerminalChatAuthError } from './authError';
import { ConversationView } from './ConversationView';
import type {
  ChatClientSessionDto,
  ChatConversationStateDto,
  ChatRealtimeClient,
  ChatRuntimeApi,
  ChatSessionConversationDto,
} from './types';

export interface ClientChatScreenProps {
  readonly accountId: string;
  readonly ownDisplayName: string;
  readonly session: ChatClientSessionDto;
  readonly api: ChatRuntimeApi;
  readonly realtime: ChatRealtimeClient;
  readonly online: boolean;
  readonly supportEmail: string;
  readonly photoUploadsEnabled?: boolean;
  readonly onBack: () => void;
  readonly onSessionExpired: () => void;
  readonly onConversationStateChange?: (
    conversationId: string,
    state: ChatConversationStateDto,
  ) => void;
  readonly registerObjectUrl?: (url: string) => () => void;
}

type ConversationBootstrapState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly conversation: ChatSessionConversationDto }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

const errorCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  return typeof error.code === 'string' ? error.code : null;
};

const controlledUnavailableMessage = (enabled: boolean, available: boolean): string | null => {
  if (!enabled) {
    return 'Чат временно отключён.';
  }

  return available ? null : 'Персональный тренер пока не назначен.';
};

export const ClientChatScreen = ({
  accountId,
  ownDisplayName,
  session,
  api,
  realtime,
  online,
  supportEmail,
  photoUploadsEnabled = false,
  onBack,
  onSessionExpired,
  onConversationStateChange,
  registerObjectUrl,
}: ClientChatScreenProps): ReactNode => {
  const initialUnavailable = controlledUnavailableMessage(session.enabled, session.available);
  const [bootstrap, setBootstrap] = useState<ConversationBootstrapState>(() =>
    initialUnavailable !== null
      ? { kind: 'unavailable', message: initialUnavailable }
      : session.conversation === null
        ? { kind: 'loading' }
        : { kind: 'ready', conversation: session.conversation },
  );
  const requestVersionRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const createConversation = useCallback((): void => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    const version = ++requestVersionRef.current;
    controllerRef.current = controller;
    setBootstrap({ kind: 'loading' });

    void api
      .createConversation(controller.signal)
      .then((conversation) => {
        if (!controller.signal.aborted && requestVersionRef.current === version) {
          setBootstrap({ kind: 'ready', conversation });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestVersionRef.current !== version) {
          return;
        }

        if (isTerminalChatAuthError(error)) {
          onSessionExpired();
          return;
        }

        const code = errorCode(error);
        if (code === 'CHAT_DISABLED' || code === 'CHAT_TRAINER_UNAVAILABLE') {
          setBootstrap({
            kind: 'unavailable',
            message:
              code === 'CHAT_DISABLED'
                ? 'Чат временно отключён.'
                : 'Персональный тренер пока не назначен.',
          });
          return;
        }

        setBootstrap({
          kind: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Не удалось открыть чат. Проверьте соединение и попробуйте ещё раз.',
        });
      })
      .finally(() => {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
      });
  }, [api, onSessionExpired]);

  useEffect(() => {
    const unavailable = controlledUnavailableMessage(session.enabled, session.available);
    if (unavailable !== null) {
      setBootstrap({ kind: 'unavailable', message: unavailable });
      return undefined;
    }

    if (session.conversation !== null) {
      setBootstrap({ kind: 'ready', conversation: session.conversation });
      return undefined;
    }

    createConversation();
    return () => {
      controllerRef.current?.abort();
      requestVersionRef.current += 1;
    };
  }, [createConversation, session.available, session.conversation, session.enabled]);

  const activeConversationId = bootstrap.kind === 'ready' ? bootstrap.conversation.id : null;
  const handleConversationStateChange = useCallback(
    (state: ChatConversationStateDto): void => {
      if (activeConversationId !== null) {
        onConversationStateChange?.(activeConversationId, state);
      }
    },
    [activeConversationId, onConversationStateChange],
  );

  if (bootstrap.kind === 'loading') {
    return (
      <main className="chat-bootstrap-shell" data-testid="chat-bootstrap-loading">
        <div role="status">Открываем защищённый чат…</div>
      </main>
    );
  }

  if (bootstrap.kind === 'unavailable') {
    return (
      <main className="chat-bootstrap-shell" data-testid="chat-unavailable">
        <section className="chat-bootstrap-card" aria-labelledby="chat-unavailable-title">
          <h1 id="chat-unavailable-title">Чат пока недоступен</h1>
          <p>{bootstrap.message}</p>
          <a href={`mailto:${supportEmail}`}>Написать в поддержку</a>
          <button type="button" onClick={onBack}>
            Назад
          </button>
        </section>
      </main>
    );
  }

  if (bootstrap.kind === 'error') {
    return (
      <main className="chat-bootstrap-shell" data-testid="chat-bootstrap-error">
        <section className="chat-bootstrap-card" aria-labelledby="chat-error-title">
          <h1 id="chat-error-title">Чат не загрузился</h1>
          <p role="alert">{bootstrap.message}</p>
          <button type="button" onClick={createConversation}>
            Повторить
          </button>
          <button type="button" onClick={onBack}>
            Назад
          </button>
        </section>
      </main>
    );
  }

  return (
    <React.Fragment>
      <ConversationView
        accountId={accountId}
        conversationId={bootstrap.conversation.id}
        role="client"
        ownDisplayName={ownDisplayName}
        counterpart={bootstrap.conversation.trainer}
        api={api}
        realtime={realtime}
        online={online}
        photoUploadsEnabled={photoUploadsEnabled}
        onBack={onBack}
        onSessionExpired={onSessionExpired}
        onConversationStateChange={handleConversationStateChange}
        {...(registerObjectUrl === undefined ? {} : { registerObjectUrl })}
      />
    </React.Fragment>
  );
};
