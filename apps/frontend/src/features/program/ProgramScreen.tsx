import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProgramDay, SubscriptionResponse, WeekResponse } from '@kinetra/shared';

import { ApiRequestError, getCurrentWeek, getWeek } from '../../lib/api';
import { isSubscriptionActive } from '../payments/model';
import { SubscriptionPaywallDialog } from '../payments/SubscriptionPaywallDialog';
import { SubscriptionLockedScreen } from '../payments/SubscriptionLockedScreen';

import { clearWorkoutHistorySentinel } from './history';
import { dayOfWeekInTimeZone, optimisticallyCompleteWorkout } from './model';
import { ProgramWeekView } from './ProgramWeekView';
import { WorkoutPlayer } from './WorkoutPlayer';

type ProgramLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly response: WeekResponse;
      readonly currentWeekNumber: number;
    };

export interface ProgramScreenProps {
  readonly timezone: string;
  readonly subscription: SubscriptionResponse;
  readonly onOpenPayment: () => void;
  readonly onSubscriptionRequired: () => void;
  readonly onWorkoutCompletionBusyChange: (busy: boolean) => void;
  readonly onSessionExpired: () => void;
}

const loadErrorMessage = (error: unknown): string =>
  error instanceof ApiRequestError
    ? error.message
    : 'Не удалось загрузить программу. Попробуйте ещё раз.';

interface WorkoutHistorySelection {
  readonly videoId: string | null;
  readonly programWeek: number | null;
}

const programWeekFromHistory = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 12 ? value : null;

const workoutSelectionFromHistory = (): WorkoutHistorySelection => {
  if (typeof window === 'undefined') {
    return { videoId: null, programWeek: null };
  }

  const videoId = window.history.state?.kinetraWorkoutVideoId;
  const programWeek = window.history.state?.kinetraProgramWeek;

  return {
    videoId: typeof videoId === 'string' ? videoId : null,
    programWeek: programWeekFromHistory(programWeek),
  };
};

export const ProgramScreen = ({
  timezone,
  subscription,
  onOpenPayment,
  onSubscriptionRequired,
  onWorkoutCompletionBusyChange,
  onSessionExpired,
}: ProgramScreenProps): ReactNode => {
  const initialWorkoutSelection = React.useMemo(workoutSelectionFromHistory, []);
  const initiallyActive = isSubscriptionActive(subscription);
  const [loadState, setLoadState] = useState<ProgramLoadState>(
    initiallyActive ? { kind: 'loading' } : { kind: 'blocked' },
  );
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(
    initialWorkoutSelection.videoId,
  );
  const [isNavigating, setIsNavigating] = useState(false);
  const [isCompletingWorkout, setIsCompletingWorkout] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(!initiallyActive);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const focusReturnDay = useRef<number | null>(null);
  const selectedVideoIdRef = useRef<string | null>(selectedVideoId);
  const selectedProgramWeekRef = useRef<number | null>(initialWorkoutSelection.programWeek);
  const visibleWeekNumberRef = useRef<number | null>(null);
  const currentWeekNumberRef = useRef<number | null>(null);
  const completionBusyRef = useRef(false);
  const todayDayOfWeek = useMemo(() => dayOfWeekInTimeZone(new Date(), timezone), [timezone]);
  const subscriptionActive = isSubscriptionActive(subscription);

  const handleAuthError = useCallback(
    (error: unknown): boolean => {
      if (error instanceof ApiRequestError && error.kind === 'auth') {
        onSessionExpired();
        return true;
      }

      if (error instanceof ApiRequestError && error.code === 'SUBSCRIPTION_REQUIRED') {
        requestController.current?.abort();
        clearWorkoutHistorySentinel();
        selectedVideoIdRef.current = null;
        selectedProgramWeekRef.current = null;
        setSelectedVideoId(null);
        setLoadState({ kind: 'blocked' });
        setPaywallOpen(true);
        onSubscriptionRequired();
        return true;
      }

      return false;
    },
    [onSessionExpired, onSubscriptionRequired],
  );

  const restoreCurrentWeek = useCallback(async (): Promise<void> => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const version = ++requestVersion.current;
    setLoadState({ kind: 'loading' });
    setNavigationError(null);

    try {
      const currentResponse = await getCurrentWeek(controller.signal);
      currentWeekNumberRef.current = currentResponse.week.week_number;
      const selectedProgramWeek = selectedProgramWeekRef.current;
      const response =
        selectedVideoIdRef.current !== null &&
        selectedProgramWeek !== null &&
        selectedProgramWeek !== currentResponse.week.week_number
          ? await getWeek(selectedProgramWeek, controller.signal)
          : currentResponse;

      if (requestVersion.current === version) {
        visibleWeekNumberRef.current = response.week.week_number;
        setLoadState({
          kind: 'ready',
          response,
          currentWeekNumber: currentResponse.week.week_number,
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      if (requestVersion.current === version && !handleAuthError(error)) {
        setLoadState({ kind: 'failed', message: loadErrorMessage(error) });
      }
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
      }
    }
  }, [handleAuthError]);

  const restoreHistoryWorkout = useCallback(
    async (videoId: string, programWeek: number): Promise<void> => {
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      const version = ++requestVersion.current;
      setIsNavigating(true);
      setNavigationError(null);

      try {
        const currentResponse =
          currentWeekNumberRef.current === null ? await getCurrentWeek(controller.signal) : null;
        const currentWeekNumber = currentResponse?.week.week_number ?? currentWeekNumberRef.current;

        if (currentWeekNumber === null) {
          throw new Error('The current program week could not be restored.');
        }

        currentWeekNumberRef.current = currentWeekNumber;
        const response =
          currentResponse !== null && currentResponse.week.week_number === programWeek
            ? currentResponse
            : await getWeek(programWeek, controller.signal);

        if (requestVersion.current === version) {
          visibleWeekNumberRef.current = response.week.week_number;
          selectedVideoIdRef.current = videoId;
          selectedProgramWeekRef.current = programWeek;
          setLoadState({ kind: 'ready', response, currentWeekNumber });
          setSelectedVideoId(videoId);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        if (requestVersion.current === version && !handleAuthError(error)) {
          const message = loadErrorMessage(error);
          if (window.history.state?.kinetraWorkoutVideoId === videoId) {
            clearWorkoutHistorySentinel();
          }
          selectedVideoIdRef.current = null;
          selectedProgramWeekRef.current = null;
          setSelectedVideoId(null);
          setLoadState((current) =>
            current.kind === 'ready' ? current : { kind: 'failed', message },
          );
          setNavigationError(message);
        }
      } finally {
        if (requestVersion.current === version) {
          setIsNavigating(false);
        }
        if (requestController.current === controller) {
          requestController.current = null;
        }
      }
    },
    [handleAuthError],
  );

  useEffect(() => {
    if (!subscriptionActive) {
      requestVersion.current += 1;
      requestController.current?.abort();
      requestController.current = null;
      clearWorkoutHistorySentinel();
      selectedVideoIdRef.current = null;
      selectedProgramWeekRef.current = null;
      setSelectedVideoId(null);
      setLoadState({ kind: 'blocked' });
      setPaywallOpen(true);
      return;
    }

    void restoreCurrentWeek();

    return () => {
      requestVersion.current += 1;
      requestController.current?.abort();
      requestController.current = null;
    };
  }, [restoreCurrentWeek, subscriptionActive]);

  useEffect(() => {
    const restoreWorkoutFromHistory = (event: PopStateEvent): void => {
      const videoId = event.state?.kinetraWorkoutVideoId;
      const programWeek = event.state?.kinetraProgramWeek;
      const restoredVideoId = typeof videoId === 'string' ? videoId : null;
      const restoredProgramWeek = programWeekFromHistory(programWeek);

      if (restoredVideoId !== null && !isSubscriptionActive(subscription)) {
        clearWorkoutHistorySentinel();
        selectedVideoIdRef.current = null;
        selectedProgramWeekRef.current = null;
        setSelectedVideoId(null);
        setPaywallOpen(true);
        return;
      }

      if (
        completionBusyRef.current &&
        selectedVideoIdRef.current !== null &&
        restoredVideoId !== selectedVideoIdRef.current
      ) {
        window.history.pushState(
          {
            kinetraWorkoutVideoId: selectedVideoIdRef.current,
            kinetraProgramWeek: selectedProgramWeekRef.current,
          },
          '',
          window.location.href,
        );
        return;
      }

      if (
        restoredVideoId !== null &&
        restoredProgramWeek !== null &&
        visibleWeekNumberRef.current !== restoredProgramWeek
      ) {
        selectedVideoIdRef.current = restoredVideoId;
        selectedProgramWeekRef.current = restoredProgramWeek;
        void restoreHistoryWorkout(restoredVideoId, restoredProgramWeek);
        return;
      }

      if (restoredVideoId === null) {
        requestVersion.current += 1;
        requestController.current?.abort();
        requestController.current = null;
        setIsNavigating(false);
      }

      selectedVideoIdRef.current = restoredVideoId;
      selectedProgramWeekRef.current = restoredProgramWeek;
      setSelectedVideoId(restoredVideoId);
    };

    window.addEventListener('popstate', restoreWorkoutFromHistory);
    return () => window.removeEventListener('popstate', restoreWorkoutFromHistory);
  }, [restoreHistoryWorkout, subscription]);

  useEffect(() => {
    if (subscriptionActive || selectedVideoId === null) {
      return;
    }

    clearWorkoutHistorySentinel();
    selectedVideoIdRef.current = null;
    selectedProgramWeekRef.current = null;
    setSelectedVideoId(null);
    setPaywallOpen(true);
  }, [selectedVideoId, subscriptionActive]);

  useEffect(
    () => () => {
      onWorkoutCompletionBusyChange(false);
    },
    [onWorkoutCompletionBusyChange],
  );

  const handleCompletionBusyChange = useCallback(
    (busy: boolean): void => {
      completionBusyRef.current = busy;
      setIsCompletingWorkout(busy);
      onWorkoutCompletionBusyChange(busy);
    },
    [onWorkoutCompletionBusyChange],
  );

  useEffect(() => {
    if (
      loadState.kind !== 'ready' ||
      selectedVideoId === null ||
      loadState.response.week.days.some(({ video }) => video.id === selectedVideoId)
    ) {
      return;
    }

    if (window.history.state?.kinetraWorkoutVideoId === selectedVideoId) {
      clearWorkoutHistorySentinel();
    }
    selectedVideoIdRef.current = null;
    selectedProgramWeekRef.current = null;
    setSelectedVideoId(null);
  }, [loadState, selectedVideoId]);

  useEffect(() => {
    if (selectedVideoId !== null || focusReturnDay.current === null) {
      return;
    }

    const dayOfWeek = focusReturnDay.current;
    focusReturnDay.current = null;
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-testid="workout-card-${dayOfWeek}"]`)?.focus();
    });
  }, [selectedVideoId]);

  const navigateToWeek = useCallback(
    async (weekNumber: number): Promise<void> => {
      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      const version = ++requestVersion.current;
      setIsNavigating(true);
      setNavigationError(null);

      try {
        const response = await getWeek(weekNumber, controller.signal);

        if (requestVersion.current === version) {
          visibleWeekNumberRef.current = response.week.week_number;
          setLoadState((current) =>
            current.kind === 'ready' ? { ...current, response } : current,
          );
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        if (requestVersion.current === version && !handleAuthError(error)) {
          setNavigationError(loadErrorMessage(error));
        }
      } finally {
        if (requestVersion.current === version) {
          setIsNavigating(false);
        }
        if (requestController.current === controller) {
          requestController.current = null;
        }
      }
    },
    [handleAuthError],
  );

  const handleWorkoutCompleted = useCallback(
    (videoId: string, selectedWeekNumber: number, currentResponse: WeekResponse): void => {
      const completedAt = new Date().toISOString();
      const boundaryShifted = currentResponse.week.week_number !== selectedWeekNumber;
      currentWeekNumberRef.current = currentResponse.week.week_number;

      setLoadState((current) => {
        if (current.kind !== 'ready') {
          return current;
        }

        if (!boundaryShifted && current.response.week.week_number === selectedWeekNumber) {
          return {
            kind: 'ready',
            response: currentResponse,
            currentWeekNumber: currentResponse.week.week_number,
          };
        }

        const optimistic = optimisticallyCompleteWorkout(current.response, videoId, completedAt);

        return {
          kind: 'ready',
          response: {
            ...optimistic,
            total_weeks: currentResponse.total_weeks,
            overall_progress: currentResponse.overall_progress,
          },
          currentWeekNumber: currentResponse.week.week_number,
        };
      });

      if (!boundaryShifted) {
        return;
      }

      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      const version = ++requestVersion.current;

      void getWeek(selectedWeekNumber, controller.signal)
        .then((response) => {
          if (requestVersion.current !== version) {
            return;
          }

          setLoadState((current) =>
            current.kind === 'ready' && current.response.week.week_number === selectedWeekNumber
              ? { ...current, response }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            handleAuthError(error);
          }
        })
        .finally(() => {
          if (requestController.current === controller) {
            requestController.current = null;
          }
        });
    },
    [handleAuthError],
  );

  if (loadState.kind === 'loading') {
    return (
      <main className="program-state-shell" data-testid="program-loading">
        <div className="loading-state" role="status" aria-live="polite">
          <span aria-hidden="true" />
          Загружаем вашу неделю…
        </div>
      </main>
    );
  }

  if (loadState.kind === 'failed') {
    return (
      <main className="program-state-shell" data-testid="program-error">
        <section className="program-state-card" aria-labelledby="program-error-title">
          <p className="program-kicker">KINETRA</p>
          <h1 id="program-error-title">Неделя пока не загрузилась</h1>
          <p>{loadState.message}</p>
          <button
            className="primary-button program-retry"
            type="button"
            onClick={() => void restoreCurrentWeek()}
          >
            Повторить
          </button>
        </section>
      </main>
    );
  }

  if (loadState.kind === 'blocked') {
    return <SubscriptionLockedScreen subscription={subscription} onOpenPayment={onOpenPayment} />;
  }

  const selectedDay =
    selectedVideoId === null
      ? undefined
      : loadState.response.week.days.find(({ video }) => video.id === selectedVideoId);

  if (selectedDay !== undefined && subscriptionActive) {
    return (
      <WorkoutPlayer
        day={selectedDay}
        programWeek={loadState.response.week.week_number}
        onCompleted={(response) =>
          handleWorkoutCompleted(
            selectedDay.video.id,
            loadState.response.week.week_number,
            response,
          )
        }
        onCompletionBusyChange={handleCompletionBusyChange}
        onClosed={() => {
          if (window.history.state?.kinetraWorkoutVideoId === selectedDay.video.id) {
            window.history.back();
            return;
          }

          selectedVideoIdRef.current = null;
          selectedProgramWeekRef.current = null;
          setSelectedVideoId(null);
        }}
        onSessionExpired={onSessionExpired}
      />
    );
  }

  const selectWorkout = (day: ProgramDay): void => {
    if (isNavigating || isCompletingWorkout) {
      return;
    }

    if (!isSubscriptionActive(subscription)) {
      setPaywallOpen(true);
      return;
    }

    focusReturnDay.current = day.day_of_week;
    setNavigationError(null);
    window.history.pushState(
      {
        kinetraWorkoutVideoId: day.video.id,
        kinetraProgramWeek: loadState.response.week.week_number,
      },
      '',
      window.location.href,
    );
    selectedVideoIdRef.current = day.video.id;
    selectedProgramWeekRef.current = loadState.response.week.week_number;
    setSelectedVideoId(day.video.id);
  };

  return (
    <>
      <ProgramWeekView
        response={loadState.response}
        currentWeekNumber={loadState.currentWeekNumber}
        todayDayOfWeek={todayDayOfWeek}
        isNavigating={isNavigating || isCompletingWorkout}
        navigationError={navigationError}
        onPreviousWeek={() => void navigateToWeek(loadState.response.week.week_number - 1)}
        onNextWeek={() => void navigateToWeek(loadState.response.week.week_number + 1)}
        onSelectWorkout={selectWorkout}
      />
      <SubscriptionPaywallDialog
        open={paywallOpen || (selectedDay !== undefined && !subscriptionActive)}
        subscription={subscription}
        onClose={() => setPaywallOpen(false)}
        onRenew={() => {
          clearWorkoutHistorySentinel();
          selectedVideoIdRef.current = null;
          selectedProgramWeekRef.current = null;
          setSelectedVideoId(null);
          setPaywallOpen(false);
          onOpenPayment();
        }}
      />
    </>
  );
};
