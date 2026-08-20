import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BaseLessonsResponse, MeResponse } from '@kinetra/shared';

import { ApiRequestError, completeBaseProgram, getBaseLessons } from '../../lib/api';

import { BaseLessonsView } from './BaseLessonsView';
import { LessonPlayer } from './LessonPlayer';
import { LatestRequestGuard, mergeSavedLessonProgress } from './model';

type BaseLessonsLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly response: BaseLessonsResponse };

export interface BaseLessonsScreenProps {
  readonly onCompleted: (profile: MeResponse) => void;
  readonly onOpenSettings: () => void;
  readonly onSessionExpired: () => void;
}

const messageForLoadError = (error: unknown): string =>
  error instanceof ApiRequestError
    ? error.message
    : 'Не удалось загрузить базовые уроки. Попробуйте ещё раз.';

export const BaseLessonsScreen = ({
  onCompleted,
  onOpenSettings,
  onSessionExpired,
}: BaseLessonsScreenProps): ReactNode => {
  const [loadState, setLoadState] = useState<BaseLessonsLoadState>({ kind: 'loading' });
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const completionInFlight = useRef(false);
  const focusReturnOrder = useRef<number | null>(null);
  const backgroundRefreshGuard = useRef(new LatestRequestGuard());
  const backgroundRefreshController = useRef<AbortController | null>(null);

  const handleAuthError = useCallback(
    (error: unknown): boolean => {
      if (error instanceof ApiRequestError && error.kind === 'auth') {
        onSessionExpired();
        return true;
      }

      return false;
    },
    [onSessionExpired],
  );

  const loadLessons = useCallback(
    async (signal?: AbortSignal): Promise<BaseLessonsResponse> => {
      try {
        return await getBaseLessons(signal);
      } catch (error) {
        handleAuthError(error);
        throw error;
      }
    },
    [handleAuthError],
  );

  const restoreLessons = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoadState({ kind: 'loading' });

      try {
        const response = await loadLessons(signal);
        setLoadState({ kind: 'ready', response });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        if (!(error instanceof ApiRequestError && error.kind === 'auth')) {
          setLoadState({ kind: 'failed', message: messageForLoadError(error) });
        }
      }
    },
    [loadLessons],
  );

  useEffect(() => {
    const controller = new AbortController();
    void restoreLessons(controller.signal);
    return () => controller.abort();
  }, [restoreLessons]);

  useEffect(
    () => () => {
      backgroundRefreshController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (selectedLessonId !== null || focusReturnOrder.current === null) {
      return;
    }

    const orderIndex = focusReturnOrder.current;
    focusReturnOrder.current = null;
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-testid="base-lesson-card-${orderIndex}"]`)
        ?.focus();
    });
  }, [selectedLessonId]);

  if (loadState.kind === 'loading') {
    return (
      <main className="base-lessons-state-shell" data-testid="base-lessons-loading">
        <div className="loading-state" role="status" aria-live="polite">
          <span aria-hidden="true" />
          Загружаем базовые уроки…
        </div>
      </main>
    );
  }

  if (loadState.kind === 'failed') {
    return (
      <main className="base-lessons-state-shell" data-testid="base-lessons-error">
        <section className="base-lessons-state-card" aria-labelledby="base-lessons-error-title">
          <div className="survey-brand">
            <span className="survey-brand-mark" aria-hidden="true">
              K
            </span>
            <span>KINETRA</span>
          </div>
          <h1 id="base-lessons-error-title">Уроки пока не загрузились</h1>
          <p>{loadState.message}</p>
          <button
            className="primary-button base-lessons-retry"
            type="button"
            onClick={() => void restoreLessons()}
          >
            Повторить
          </button>
        </section>
      </main>
    );
  }

  const selectedLesson =
    selectedLessonId === null
      ? undefined
      : loadState.response.lessons.find(({ id }) => id === selectedLessonId);

  if (selectedLesson !== undefined) {
    return (
      <LessonPlayer
        lesson={selectedLesson}
        onClosed={(savedProgress) => {
          backgroundRefreshController.current?.abort();
          const controller = new AbortController();
          backgroundRefreshController.current = controller;
          const refreshRequest = backgroundRefreshGuard.current.begin();
          setLoadState({
            kind: 'ready',
            response: mergeSavedLessonProgress(
              loadState.response,
              selectedLesson.id,
              savedProgress,
            ),
          });
          setSelectedLessonId(null);
          void loadLessons(controller.signal)
            .then((response) => {
              if (backgroundRefreshGuard.current.isLatest(refreshRequest)) {
                setLoadState({ kind: 'ready', response });
              }
            })
            .catch(() => undefined)
            .finally(() => {
              if (backgroundRefreshController.current === controller) {
                backgroundRefreshController.current = null;
              }
            });
        }}
        onSessionExpired={onSessionExpired}
      />
    );
  }

  const completeProgram = async (): Promise<void> => {
    if (completionInFlight.current || !loadState.response.program_unlocked) {
      return;
    }

    completionInFlight.current = true;
    setIsCompleting(true);
    setActionError(null);

    try {
      const profile = await completeBaseProgram();
      onCompleted(profile);
    } catch (error) {
      if (!handleAuthError(error)) {
        setActionError(
          error instanceof ApiRequestError
            ? error.message
            : 'Не удалось открыть программу. Попробуйте ещё раз.',
        );
      }
    } finally {
      completionInFlight.current = false;
      setIsCompleting(false);
    }
  };

  return (
    <BaseLessonsView
      response={loadState.response}
      isCompleting={isCompleting}
      errorMessage={actionError}
      onSelectLesson={(lessonId) => {
        backgroundRefreshGuard.current.begin();
        backgroundRefreshController.current?.abort();
        backgroundRefreshController.current = null;
        const lesson = loadState.response.lessons.find(({ id }) => id === lessonId);
        focusReturnOrder.current = lesson?.order_index ?? null;
        setActionError(null);
        setSelectedLessonId(lessonId);
      }}
      onComplete={() => void completeProgram()}
      onOpenSettings={onOpenSettings}
    />
  );
};
