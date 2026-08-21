import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MeResponse, ProgressResponse, SurveyGoal, WeeklyMetricsInput } from '@kinetra/shared';

import {
  ApiRequestError,
  fetchMe,
  getProgress,
  submitWeeklyMetrics,
  updateGoal,
} from '../../lib/api';
import { GoalDialog, WeeklyMetricsDialog } from './ProgressDialogs';
import { ProgressView } from './ProgressView';
import { withUpdatedGoal, withUpdatedMetrics, type ProgressMetricKey } from './model';

type ProgressLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly response: ProgressResponse }
  | { readonly kind: 'error'; readonly message: string };

type ActiveProgressDialog = 'goal' | 'metrics' | null;

export interface ProgressScreenProps {
  readonly timezone: string;
  readonly onGoalChanged: (goal: SurveyGoal) => void;
  readonly onProfileUpdated: (profile: MeResponse) => void;
  readonly onSessionExpired: () => void;
}

const ProgressState = ({
  kind,
  message,
  onRetry,
}: {
  readonly kind: 'loading' | 'error';
  readonly message: string;
  readonly onRetry?: () => void;
}): ReactNode => (
  <main className="progress-state-shell" data-testid="progress-screen">
    <section
      className="progress-state-card"
      data-testid={`progress-${kind}`}
      role={kind === 'loading' ? 'status' : 'alert'}
      {...(kind === 'loading' ? { 'aria-live': 'polite' as const } : {})}
      aria-busy={kind === 'loading'}
    >
      <p className="program-kicker">ПРОГРЕСС</p>
      <h1>{kind === 'loading' ? 'Собираем вашу динамику' : 'Не удалось загрузить прогресс'}</h1>
      <p>{message}</p>
      {onRetry === undefined ? null : (
        <button
          className="primary-button progress-retry"
          data-testid="progress-retry"
          type="button"
          onClick={onRetry}
        >
          Повторить
        </button>
      )}
    </section>
  </main>
);

const mutationMessage = (error: unknown): string =>
  error instanceof ApiRequestError
    ? error.message
    : 'Не удалось сохранить изменения. Попробуйте ещё раз.';

export const ProgressScreen = ({
  timezone,
  onGoalChanged,
  onProfileUpdated,
  onSessionExpired,
}: ProgressScreenProps): ReactNode => {
  const [state, setState] = useState<ProgressLoadState>({ kind: 'loading' });
  const [selectedMetric, setSelectedMetric] = useState<ProgressMetricKey>('energy');
  const [activeDialog, setActiveDialog] = useState<ActiveProgressDialog>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const mutationInFlightRef = useRef(false);
  const focusTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const loadProgress = useCallback(async (): Promise<void> => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setState({ kind: 'loading' });

    try {
      const response = await getProgress(controller.signal);

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
  }, [onSessionExpired]);

  useEffect(() => {
    mountedRef.current = true;
    void loadProgress();

    return () => {
      mountedRef.current = false;
      requestControllerRef.current?.abort();

      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
    };
  }, [loadProgress]);

  const openDialog = (dialog: Exclude<ActiveProgressDialog, null>): void => {
    setMutationError(null);
    setActiveDialog(dialog);
  };

  const closeDialog = (): void => {
    if (!mutationInFlightRef.current) {
      setMutationError(null);
      setActiveDialog(null);
    }
  };

  const beginMutation = (): boolean => {
    if (mutationInFlightRef.current) {
      return false;
    }

    mutationInFlightRef.current = true;
    setMutationBusy(true);
    setMutationError(null);
    return true;
  };

  const endMutation = (): void => {
    mutationInFlightRef.current = false;

    if (mountedRef.current) {
      setMutationBusy(false);
    }
  };

  const saveGoal = async (goal: SurveyGoal): Promise<void> => {
    if (!beginMutation()) {
      return;
    }

    try {
      const updatedGoal = await updateGoal(goal);

      if (!mountedRef.current) {
        return;
      }

      setState((current) =>
        current.kind === 'ready'
          ? { kind: 'ready', response: withUpdatedGoal(current.response, updatedGoal) }
          : current,
      );
      onGoalChanged(updatedGoal.current_goal);
      setActiveDialog(null);

      void fetchMe()
        .then((profile) => {
          if (mountedRef.current) {
            onProfileUpdated(profile);
          }
        })
        .catch((error: unknown) => {
          if (error instanceof ApiRequestError && error.kind === 'auth' && mountedRef.current) {
            onSessionExpired();
          }
        });
    } catch (error) {
      if (error instanceof ApiRequestError && error.kind === 'auth') {
        onSessionExpired();
        return;
      }

      if (mountedRef.current) {
        setMutationError(mutationMessage(error));
      }
    } finally {
      endMutation();
    }
  };

  const saveWeeklyMetrics = async (input: WeeklyMetricsInput): Promise<void> => {
    if (!beginMutation()) {
      return;
    }

    try {
      const metrics = await submitWeeklyMetrics(input);

      if (!mountedRef.current) {
        return;
      }

      setState((current) =>
        current.kind === 'ready'
          ? { kind: 'ready', response: withUpdatedMetrics(current.response, metrics) }
          : current,
      );
      setActiveDialog(null);
      focusTimerRef.current = window.setTimeout(() => {
        document.querySelector<HTMLElement>('#progress-metrics-heading')?.focus();
        focusTimerRef.current = null;
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.kind === 'auth') {
        onSessionExpired();
        return;
      }

      if (mountedRef.current) {
        setMutationError(mutationMessage(error));
      }
    } finally {
      endMutation();
    }
  };

  if (state.kind === 'loading') {
    return <ProgressState kind="loading" message="Готовим метрики, статистику и достижения." />;
  }

  if (state.kind === 'error') {
    return (
      <ProgressState kind="error" message={state.message} onRetry={() => void loadProgress()} />
    );
  }

  return (
    <Fragment>
      <ProgressView
        response={state.response}
        timezone={timezone}
        selectedMetric={selectedMetric}
        onMetricChange={setSelectedMetric}
        onEditGoal={() => openDialog('goal')}
        onOpenWeeklyMetrics={() => openDialog('metrics')}
      />
      {activeDialog === 'goal' ? (
        <GoalDialog
          currentGoal={state.response.goal.current_goal}
          busy={mutationBusy}
          error={mutationError}
          onClose={closeDialog}
          onSave={(goal) => void saveGoal(goal)}
        />
      ) : null}
      {activeDialog === 'metrics' ? (
        <WeeklyMetricsDialog
          currentWeek={state.response.metrics.current_week}
          busy={mutationBusy}
          error={mutationError}
          onClose={closeDialog}
          onSave={(input) => void saveWeeklyMetrics(input)}
        />
      ) : null}
    </Fragment>
  );
};
