import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ScheduleResponse } from '@kinetra/shared';

import { ApiRequestError, getSchedule } from '../../lib/api';
import { ScheduleView, type ScheduleSection } from './ScheduleView';

type ScheduleLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly response: ScheduleResponse }
  | { readonly kind: 'error'; readonly message: string };

export interface ScheduleScreenProps {
  readonly onOpenHome: () => void;
  readonly onSessionExpired: () => void;
  readonly onSubscriptionRequired: () => void;
}

const ScheduleState = ({
  kind,
  message,
  onRetry,
}: {
  readonly kind: 'loading' | 'error';
  readonly message: string;
  readonly onRetry?: () => void;
}): ReactNode => (
  <main className="schedule-state-shell" data-testid="schedule-screen">
    <section
      className="schedule-state-card"
      data-testid={`schedule-${kind}`}
      role={kind === 'loading' ? 'status' : 'alert'}
      aria-live="polite"
      aria-busy={kind === 'loading'}
    >
      <p className="program-kicker">РАСПИСАНИЕ</p>
      <h1>{kind === 'loading' ? 'Собираем вашу неделю' : 'Не удалось загрузить расписание'}</h1>
      <p>{message}</p>
      {onRetry === undefined ? null : (
        <button
          className="primary-button schedule-retry"
          data-testid="schedule-retry"
          type="button"
          onClick={onRetry}
        >
          Повторить
        </button>
      )}
    </section>
  </main>
);

export const ScheduleScreen = ({
  onOpenHome,
  onSessionExpired,
  onSubscriptionRequired,
}: ScheduleScreenProps): ReactNode => {
  const [state, setState] = useState<ScheduleLoadState>({ kind: 'loading' });
  const [activeSection, setActiveSection] = useState<ScheduleSection>('current');
  const requestControllerRef = useRef<AbortController | null>(null);

  const loadSchedule = useCallback(async (): Promise<void> => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setState({ kind: 'loading' });

    try {
      const response = await getSchedule(controller.signal);

      if (requestControllerRef.current !== controller) {
        return;
      }

      setState({ kind: 'ready', response });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      if (error instanceof ApiRequestError && error.kind === 'auth') {
        onSessionExpired();
        return;
      }

      if (error instanceof ApiRequestError && error.code === 'SUBSCRIPTION_REQUIRED') {
        onSubscriptionRequired();
        return;
      }

      if (requestControllerRef.current !== controller) {
        return;
      }

      setState({
        kind: 'error',
        message:
          error instanceof ApiRequestError
            ? error.message
            : 'Проверьте подключение и попробуйте ещё раз.',
      });
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }, [onSessionExpired, onSubscriptionRequired]);

  useEffect(() => {
    void loadSchedule();
    return () => requestControllerRef.current?.abort();
  }, [loadSchedule]);

  if (state.kind === 'loading') {
    return <ScheduleState kind="loading" message="Готовим текущую и следующую недели программы." />;
  }

  if (state.kind === 'error') {
    return (
      <ScheduleState
        kind="error"
        message={state.message}
        onRetry={() => {
          setActiveSection('current');
          void loadSchedule();
        }}
      />
    );
  }

  return (
    <ScheduleView
      response={state.response}
      activeSection={activeSection}
      onSectionChange={setActiveSection}
      onOpenDay={onOpenHome}
    />
  );
};
