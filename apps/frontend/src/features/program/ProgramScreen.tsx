import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  BaseLessonsResponse,
  ProgramDay,
  SubscriptionResponse,
  WeekResponse,
} from '@kinetra/shared';

import { ApiRequestError, getBaseLessons, getCurrentWeek, getWeek } from '../../lib/api';
import { appRoutes } from '../../routing';
import { BaseLessonsRequiredDialog } from '../base-lessons/BaseLessonsRequiredDialog';
import { hasTrainingAccess } from '../payments/model';
import { SubscriptionPaywallDialog } from '../payments/SubscriptionPaywallDialog';
import { SubscriptionLockedScreen } from '../payments/SubscriptionLockedScreen';

import { clearWorkoutHistorySentinel } from './history';
import { dayOfWeekInTimeZone, isProgramWeekLocked, optimisticallyCompleteWorkout } from './model';
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

type PreparationLoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly response: BaseLessonsResponse }
  | { readonly kind: 'failed'; readonly message: string };

export interface ProgramScreenProps {
  readonly timezone: string;
  readonly subscription: SubscriptionResponse;
  readonly trainingLocked: boolean;
  readonly onOpenBaseLessons: () => void;
  readonly onOpenSchedule: () => void;
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
  readonly dayOfWeek: number | null;
  readonly programWeek: number | null;
}

const programWeekFromHistory = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 12 ? value : null;

const programDayFromHistory = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7 ? value : null;

const canonicalizeWorkoutHistorySelection = (videoId: string, programWeek: number): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const currentState: unknown = window.history.state;
  const nextState: Record<string, unknown> =
    typeof currentState === 'object' && currentState !== null && !Array.isArray(currentState)
      ? { ...(currentState as Record<string, unknown>) }
      : {};

  delete nextState.kinetraWorkoutDayOfWeek;
  nextState.kinetraWorkoutVideoId = videoId;
  nextState.kinetraProgramWeek = programWeek;
  window.history.replaceState(nextState, '', window.location.href);
};

const workoutSelectionFromHistory = (): WorkoutHistorySelection => {
  if (typeof window === 'undefined') {
    return { videoId: null, dayOfWeek: null, programWeek: null };
  }

  const videoId = window.history.state?.kinetraWorkoutVideoId;
  const dayOfWeek = window.history.state?.kinetraWorkoutDayOfWeek;
  const programWeek = window.history.state?.kinetraProgramWeek;

  return {
    videoId: typeof videoId === 'string' ? videoId : null,
    dayOfWeek: programDayFromHistory(dayOfWeek),
    programWeek: programWeekFromHistory(programWeek),
  };
};

export const ProgramScreen = ({
  timezone,
  subscription,
  trainingLocked,
  onOpenBaseLessons,
  onOpenSchedule,
  onOpenPayment,
  onSubscriptionRequired,
  onWorkoutCompletionBusyChange,
  onSessionExpired,
}: ProgramScreenProps): ReactNode => {
  const historyWorkoutSelection = React.useMemo(workoutSelectionFromHistory, []);
  const initialWorkoutSelection = trainingLocked
    ? { videoId: null, dayOfWeek: null, programWeek: null }
    : historyWorkoutSelection;
  const initiallyAccessible = hasTrainingAccess(subscription);
  const [loadState, setLoadState] = useState<ProgramLoadState>(
    initiallyAccessible ? { kind: 'loading' } : { kind: 'blocked' },
  );
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(
    initialWorkoutSelection.videoId,
  );
  const [isNavigating, setIsNavigating] = useState(false);
  const [isCompletingWorkout, setIsCompletingWorkout] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(!initiallyAccessible);
  const [baseLessonsDialogOpen, setBaseLessonsDialogOpen] = useState(false);
  const [preparationState, setPreparationState] = useState<PreparationLoadState>(
    trainingLocked ? { kind: 'loading' } : { kind: 'idle' },
  );
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const preparationController = useRef<AbortController | null>(null);
  const focusReturnDay = useRef<number | null>(null);
  const selectedVideoIdRef = useRef<string | null>(selectedVideoId);
  const selectedDayOfWeekRef = useRef<number | null>(initialWorkoutSelection.dayOfWeek);
  const selectedProgramWeekRef = useRef<number | null>(initialWorkoutSelection.programWeek);
  const visibleWeekNumberRef = useRef<number | null>(null);
  const currentWeekNumberRef = useRef<number | null>(null);
  const completionBusyRef = useRef(false);
  const todayDayOfWeek = useMemo(() => dayOfWeekInTimeZone(new Date(), timezone), [timezone]);
  const trainingAccessible = hasTrainingAccess(subscription);

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
        selectedDayOfWeekRef.current = null;
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

  const loadPreparation = useCallback(async (): Promise<void> => {
    preparationController.current?.abort();
    const controller = new AbortController();
    preparationController.current = controller;
    setPreparationState({ kind: 'loading' });

    try {
      const response = await getBaseLessons(controller.signal);

      if (!controller.signal.aborted && preparationController.current === controller) {
        setPreparationState({ kind: 'ready', response });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }

      if (error instanceof ApiRequestError && error.kind === 'auth') {
        onSessionExpired();
        return;
      }

      if (preparationController.current === controller) {
        setPreparationState({
          kind: 'failed',
          message: 'Не удалось обновить прогресс уроков.',
        });
      }
    } finally {
      if (preparationController.current === controller) {
        preparationController.current = null;
      }
    }
  }, [onSessionExpired]);

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
      const hasWorkoutSelection =
        selectedVideoIdRef.current !== null || selectedDayOfWeekRef.current !== null;
      const response =
        hasWorkoutSelection &&
        selectedProgramWeek !== null &&
        selectedProgramWeek !== currentResponse.week.week_number
          ? await getWeek(selectedProgramWeek, controller.signal)
          : currentResponse;

      if (requestVersion.current === version) {
        if (
          hasWorkoutSelection &&
          isProgramWeekLocked(response, currentResponse.week.week_number)
        ) {
          clearWorkoutHistorySentinel();
          selectedVideoIdRef.current = null;
          selectedDayOfWeekRef.current = null;
          selectedProgramWeekRef.current = null;
          visibleWeekNumberRef.current = currentResponse.week.week_number;
          setSelectedVideoId(null);
          setNavigationError('Эта тренировка откроется, когда начнётся выбранная неделя.');
          setLoadState({
            kind: 'ready',
            response: currentResponse,
            currentWeekNumber: currentResponse.week.week_number,
          });
          return;
        }

        if (selectedVideoIdRef.current === null && selectedDayOfWeekRef.current !== null) {
          const selectedDay = response.week.days.find(
            ({ day_of_week: dayOfWeek }) => dayOfWeek === selectedDayOfWeekRef.current,
          );

          if (selectedDay === undefined) {
            throw new Error('Выбранная тренировка не найдена в расписании этой недели.');
          }

          selectedVideoIdRef.current = selectedDay.video.id;
          canonicalizeWorkoutHistorySelection(selectedDay.video.id, response.week.week_number);
          setSelectedVideoId(selectedDay.video.id);
        }

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
    async (
      videoId: string | null,
      dayOfWeek: number | null,
      programWeek: number,
    ): Promise<void> => {
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

        if (requestVersion.current !== version) {
          return;
        }

        if (isProgramWeekLocked(response, currentWeekNumber)) {
          clearWorkoutHistorySentinel();
          selectedVideoIdRef.current = null;
          selectedDayOfWeekRef.current = null;
          selectedProgramWeekRef.current = null;
          visibleWeekNumberRef.current = currentWeekNumber;
          setSelectedVideoId(null);
          setNavigationError('Эта тренировка откроется, когда начнётся выбранная неделя.');
          const restoredCurrentResponse =
            currentResponse ?? (await getCurrentWeek(controller.signal));

          if (requestVersion.current !== version) {
            return;
          }

          setLoadState({
            kind: 'ready',
            response: restoredCurrentResponse,
            currentWeekNumber,
          });
          return;
        }
        const resolvedVideoId =
          videoId ??
          response.week.days.find(({ day_of_week: responseDay }) => responseDay === dayOfWeek)
            ?.video.id;

        if (resolvedVideoId === undefined || resolvedVideoId === null) {
          throw new Error('Выбранная тренировка не найдена в расписании этой недели.');
        }

        if (requestVersion.current === version) {
          if (dayOfWeek !== null) {
            canonicalizeWorkoutHistorySelection(resolvedVideoId, programWeek);
          }
          visibleWeekNumberRef.current = response.week.week_number;
          selectedVideoIdRef.current = resolvedVideoId;
          selectedDayOfWeekRef.current = dayOfWeek;
          selectedProgramWeekRef.current = programWeek;
          setLoadState({ kind: 'ready', response, currentWeekNumber });
          setSelectedVideoId(resolvedVideoId);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        if (requestVersion.current === version && !handleAuthError(error)) {
          const message = loadErrorMessage(error);
          if (
            window.history.state?.kinetraWorkoutVideoId === videoId ||
            window.history.state?.kinetraWorkoutDayOfWeek === dayOfWeek
          ) {
            clearWorkoutHistorySentinel();
          }
          selectedVideoIdRef.current = null;
          selectedDayOfWeekRef.current = null;
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
    if (!trainingLocked) {
      preparationController.current?.abort();
      preparationController.current = null;
      setPreparationState({ kind: 'idle' });
      setBaseLessonsDialogOpen(false);
      return;
    }

    clearWorkoutHistorySentinel();
    selectedVideoIdRef.current = null;
    selectedDayOfWeekRef.current = null;
    selectedProgramWeekRef.current = null;
    setSelectedVideoId(null);
    void loadPreparation();

    return () => {
      preparationController.current?.abort();
      preparationController.current = null;
    };
  }, [loadPreparation, trainingLocked]);

  useEffect(() => {
    if (!trainingAccessible) {
      requestVersion.current += 1;
      requestController.current?.abort();
      requestController.current = null;
      clearWorkoutHistorySentinel();
      selectedVideoIdRef.current = null;
      selectedDayOfWeekRef.current = null;
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
  }, [restoreCurrentWeek, trainingAccessible]);

  useEffect(() => {
    const restoreWorkoutFromHistory = (event: PopStateEvent): void => {
      const videoId = event.state?.kinetraWorkoutVideoId;
      const dayOfWeek = event.state?.kinetraWorkoutDayOfWeek;
      const programWeek = event.state?.kinetraProgramWeek;
      const restoredVideoId = typeof videoId === 'string' ? videoId : null;
      const restoredDayOfWeek = programDayFromHistory(dayOfWeek);
      const restoredProgramWeek = programWeekFromHistory(programWeek);
      const workoutRequested = restoredVideoId !== null || restoredDayOfWeek !== null;

      if (trainingLocked && workoutRequested) {
        clearWorkoutHistorySentinel();
        selectedVideoIdRef.current = null;
        selectedDayOfWeekRef.current = null;
        selectedProgramWeekRef.current = null;
        setSelectedVideoId(null);
        setBaseLessonsDialogOpen(true);
        return;
      }

      if (workoutRequested && !hasTrainingAccess(subscription)) {
        clearWorkoutHistorySentinel();
        selectedVideoIdRef.current = null;
        selectedDayOfWeekRef.current = null;
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
          appRoutes.home,
        );
        return;
      }

      if (
        workoutRequested &&
        restoredProgramWeek !== null &&
        (restoredDayOfWeek !== null || visibleWeekNumberRef.current !== restoredProgramWeek)
      ) {
        selectedVideoIdRef.current = restoredVideoId;
        selectedDayOfWeekRef.current = restoredDayOfWeek;
        selectedProgramWeekRef.current = restoredProgramWeek;
        void restoreHistoryWorkout(restoredVideoId, restoredDayOfWeek, restoredProgramWeek);
        return;
      }

      if (!workoutRequested) {
        requestVersion.current += 1;
        requestController.current?.abort();
        requestController.current = null;
        setIsNavigating(false);
        selectedVideoIdRef.current = null;
        selectedDayOfWeekRef.current = null;
        selectedProgramWeekRef.current = null;
        setSelectedVideoId(null);

        if (
          currentWeekNumberRef.current !== null &&
          visibleWeekNumberRef.current !== currentWeekNumberRef.current
        ) {
          void restoreCurrentWeek();
        }
        return;
      }

      selectedVideoIdRef.current = restoredVideoId;
      selectedDayOfWeekRef.current = restoredDayOfWeek;
      selectedProgramWeekRef.current = restoredProgramWeek;
      setSelectedVideoId(restoredVideoId);
    };

    window.addEventListener('popstate', restoreWorkoutFromHistory);
    return () => window.removeEventListener('popstate', restoreWorkoutFromHistory);
  }, [restoreCurrentWeek, restoreHistoryWorkout, subscription, trainingLocked]);

  useEffect(() => {
    if (trainingAccessible || selectedVideoId === null) {
      return;
    }

    clearWorkoutHistorySentinel();
    selectedVideoIdRef.current = null;
    selectedDayOfWeekRef.current = null;
    selectedProgramWeekRef.current = null;
    setSelectedVideoId(null);
    setPaywallOpen(true);
  }, [selectedVideoId, trainingAccessible]);

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
    selectedDayOfWeekRef.current = null;
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

  if (selectedDay !== undefined && trainingAccessible && !trainingLocked) {
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
          if (
            window.history.state?.kinetraWorkoutVideoId === selectedDay.video.id ||
            (window.history.state?.kinetraWorkoutDayOfWeek === selectedDay.day_of_week &&
              window.history.state?.kinetraProgramWeek === loadState.response.week.week_number)
          ) {
            window.history.back();
            return;
          }

          selectedVideoIdRef.current = null;
          selectedDayOfWeekRef.current = null;
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

    if (!hasTrainingAccess(subscription)) {
      setPaywallOpen(true);
      return;
    }

    if (trainingLocked) {
      setBaseLessonsDialogOpen(true);
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
    selectedDayOfWeekRef.current = day.day_of_week;
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
        trainingLocked={trainingLocked}
        completedBaseLessons={
          preparationState.kind === 'ready' ? preparationState.response.total_completed : null
        }
        baseLessonUnlockThreshold={
          preparationState.kind === 'ready' ? preparationState.response.unlock_threshold : null
        }
        preparationLoading={preparationState.kind === 'loading'}
        preparationError={preparationState.kind === 'failed' ? preparationState.message : null}
        onOpenBaseLessons={onOpenBaseLessons}
        onRetryPreparation={() => void loadPreparation()}
        onOpenSchedule={onOpenSchedule}
        onSelectWorkout={selectWorkout}
      />
      <BaseLessonsRequiredDialog
        open={baseLessonsDialogOpen}
        completedLessons={
          preparationState.kind === 'ready' ? preparationState.response.total_completed : null
        }
        unlockThreshold={
          preparationState.kind === 'ready' ? preparationState.response.unlock_threshold : null
        }
        onClose={() => setBaseLessonsDialogOpen(false)}
        onOpenBaseLessons={() => {
          setBaseLessonsDialogOpen(false);
          onOpenBaseLessons();
        }}
      />
      <SubscriptionPaywallDialog
        open={paywallOpen || (selectedDay !== undefined && !trainingAccessible)}
        subscription={subscription}
        onClose={() => setPaywallOpen(false)}
        onRenew={() => {
          clearWorkoutHistorySentinel();
          selectedVideoIdRef.current = null;
          selectedDayOfWeekRef.current = null;
          selectedProgramWeekRef.current = null;
          setSelectedVideoId(null);
          setPaywallOpen(false);
          onOpenPayment();
        }}
      />
    </>
  );
};
