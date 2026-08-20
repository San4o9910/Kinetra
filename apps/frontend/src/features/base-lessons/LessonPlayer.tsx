import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BaseLesson, LessonProgressResponse } from '@kinetra/shared';

import { ApiRequestError, updateLessonProgress } from '../../lib/api';

import { LessonProgressReporter, PROGRESS_SYNC_INTERVAL_MS } from './model';

const PlayerPlayIcon = (): ReactNode =>
  React.createElement(
    'svg',
    { viewBox: '0 0 24 24', 'aria-hidden': true },
    React.createElement('path', { d: 'm9 6 9 6-9 6Z' }),
  );

const BackArrowIcon = (): ReactNode => (
  <svg className="base-lesson-back-arrow" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M16 10H4M9 5l-5 5 5 5" />
  </svg>
);

export interface LessonPlayerProps {
  readonly lesson: BaseLesson;
  readonly onClosed: (savedProgress: LessonProgressResponse | null) => void;
  readonly onSessionExpired: () => void;
}

export const LessonPlayer = ({
  lesson,
  onClosed,
  onSessionExpired,
}: LessonPlayerProps): ReactNode => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeInFlight = useRef(false);
  const historyEntryActive = useRef(false);
  const mounted = useRef(true);
  const [isClosing, setIsClosing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const reporter = useMemo(
    () =>
      new LessonProgressReporter(lesson.progress.completion_percent, (progress) =>
        updateLessonProgress(lesson.id, progress),
      ),
    [lesson.id, lesson.progress.completion_percent],
  );

  useEffect(() => {
    mounted.current = true;
    headingRef.current?.focus();

    return () => {
      mounted.current = false;
    };
  }, []);

  const progressError = useCallback(
    (error: unknown): void => {
      if (error instanceof ApiRequestError && error.kind === 'auth') {
        onSessionExpired();
        return;
      }

      if (mounted.current) {
        setErrorMessage(
          error instanceof ApiRequestError
            ? error.message
            : 'Не удалось сохранить прогресс. Проверьте подключение и попробуйте ещё раз.',
        );
      }
    },
    [onSessionExpired],
  );

  const snapshotFromVideo = useCallback(
    (forceComplete = false) => {
      const video = videoRef.current;
      const positionSeconds = video?.currentTime ?? 0;
      const measuredDuration = video?.duration ?? Number.NaN;
      const durationSeconds =
        Number.isFinite(measuredDuration) && measuredDuration > 0
          ? measuredDuration
          : lesson.duration_seconds;

      return reporter.snapshot(positionSeconds, durationSeconds, forceComplete);
    },
    [lesson.duration_seconds, reporter],
  );

  const sendPeriodicProgress = useCallback(
    async (forceComplete = false): Promise<void> => {
      try {
        await reporter.enqueue(snapshotFromVideo(forceComplete));
        if (mounted.current) {
          setErrorMessage(null);
        }
      } catch (error) {
        progressError(error);
      }
    },
    [progressError, reporter, snapshotFromVideo],
  );

  useEffect(() => {
    if (lesson.video_url === null) {
      return;
    }

    const timer = window.setInterval(() => {
      const video = videoRef.current;

      if (closeInFlight.current || video === null || video.paused || video.ended) {
        return;
      }

      void sendPeriodicProgress();
    }, PROGRESS_SYNC_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [lesson.video_url, sendPeriodicProgress]);

  const handleBack = useCallback(
    async (historyAlreadyPopped = false): Promise<void> => {
      if (closeInFlight.current) {
        return;
      }

      closeInFlight.current = true;
      setIsClosing(true);
      setErrorMessage(null);
      videoRef.current?.pause();

      try {
        const savedProgress =
          lesson.video_url === null ? null : await reporter.flush(snapshotFromVideo());
        onClosed(savedProgress);

        if (!historyAlreadyPopped && historyEntryActive.current) {
          historyEntryActive.current = false;
          window.history.back();
        }
      } catch (error) {
        if (historyAlreadyPopped && !historyEntryActive.current) {
          window.history.pushState({ kinetraBaseLessonId: lesson.id }, '', window.location.href);
          historyEntryActive.current = true;
        }
        progressError(error);
      } finally {
        closeInFlight.current = false;
        if (mounted.current) {
          setIsClosing(false);
        }
      }
    },
    [lesson.id, lesson.video_url, onClosed, progressError, reporter, snapshotFromVideo],
  );

  useEffect(() => {
    if (window.history.state?.kinetraBaseLessonId !== lesson.id) {
      window.history.pushState({ kinetraBaseLessonId: lesson.id }, '', window.location.href);
    }
    historyEntryActive.current = true;

    const handlePopState = (): void => {
      if (!historyEntryActive.current) {
        return;
      }

      historyEntryActive.current = false;
      void handleBack(true);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [handleBack, lesson.id]);

  useEffect(() => {
    if (lesson.video_url === null) {
      return;
    }

    const saveBeforePageExit = (): void => {
      if (!closeInFlight.current) {
        void reporter.flush(snapshotFromVideo()).catch(() => undefined);
      }
    };
    const saveWhenHidden = (): void => {
      if (document.visibilityState === 'hidden') {
        saveBeforePageExit();
      }
    };

    window.addEventListener('pagehide', saveBeforePageExit);
    document.addEventListener('visibilitychange', saveWhenHidden);
    return () => {
      window.removeEventListener('pagehide', saveBeforePageExit);
      document.removeEventListener('visibilitychange', saveWhenHidden);
    };
  }, [lesson.video_url, reporter, snapshotFromVideo]);

  return (
    <main
      className="base-lesson-player-shell"
      data-testid="base-lesson-player"
      aria-labelledby="base-lesson-player-title"
      aria-busy={isClosing}
    >
      <section className="base-lesson-player-panel">
        <header className="base-lesson-player-header">
          <button
            className="secondary-button base-lesson-back"
            data-testid="base-lesson-back"
            type="button"
            disabled={isClosing}
            onClick={() => void handleBack(false)}
          >
            <BackArrowIcon />
            {isClosing ? 'Сохраняем…' : 'Назад'}
          </button>
          <div>
            <h1 id="base-lesson-player-title" ref={headingRef} tabIndex={-1}>
              {lesson.title}
            </h1>
          </div>
        </header>

        <div className="base-lesson-player-frame">
          {lesson.video_url === null ? (
            <div
              className="base-lesson-video-placeholder"
              data-testid="base-lesson-video-placeholder"
              role="status"
            >
              <span className="base-lesson-video-placeholder-icon">
                <PlayerPlayIcon />
              </span>
              <strong>Видео скоро будет доступно</strong>
            </div>
          ) : (
            <video
              ref={videoRef}
              className="base-lesson-video"
              data-testid="base-lesson-video"
              src={lesson.video_url}
              poster={lesson.poster_url ?? undefined}
              controls
              playsInline
              preload="metadata"
              aria-label={`Видео урока «${lesson.title}»`}
              onPause={() => {
                if (!closeInFlight.current) {
                  void sendPeriodicProgress();
                }
              }}
              onEnded={() => void sendPeriodicProgress(true)}
              onError={() =>
                setErrorMessage('Не удалось загрузить видео. Попробуйте открыть урок ещё раз.')
              }
            />
          )}
        </div>

        {lesson.description === null ? null : (
          <p className="base-lesson-player-description">{lesson.description}</p>
        )}

        {errorMessage === null ? null : (
          <p className="base-lesson-player-error" role="alert">
            {errorMessage}
          </p>
        )}
      </section>
    </main>
  );
};
