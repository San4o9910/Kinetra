import { WorkoutFeedback } from './WorkoutFeedback';
import { KineticMark } from '../navigation/KineticMark';
import { formatWorkoutTime } from './workoutQuestion';
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProgramDay, WeekResponse, WorkoutSessionResponse } from '@kinetra/shared';

import {
  ApiRequestError,
  completeWorkout,
  getWorkoutSession,
  saveWorkoutSession,
} from '../../lib/api';

import {
  directionPresentation,
  weekdayLongLabels,
  WORKOUT_COMPLETION_THRESHOLD,
  WORKOUT_PROGRESS_CHECK_INTERVAL_MS,
} from './model';

const BackIcon = (): ReactNode =>
  React.createElement(
    'svg',
    { className: 'workout-back-icon', viewBox: '0 0 24 24', 'aria-hidden': true },
    React.createElement('path', { d: 'm15 5-7 7 7 7' }),
  );

const PlaceholderPlayIcon = (): ReactNode => (
  <svg className="workout-placeholder-play" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="m10 8 6 4-6 4Z" />
  </svg>
);

export interface WorkoutPlayerProps {
  readonly day: ProgramDay;
  readonly onAskTrainer?: (day: ProgramDay, week: number, seconds: number) => void;
  readonly programWeek: number;
  readonly onCompleted: (response: WeekResponse) => void;
  readonly onCompletionBusyChange: (busy: boolean) => void;
  readonly onClosed: () => void;
  readonly onSessionExpired: () => void;
}

type CompletionState = 'idle' | 'saving' | 'completed' | 'failed';

export const WorkoutPlayer = ({
  onAskTrainer,
  day,
  programWeek,
  onCompleted,
  onCompletionBusyChange,
  onClosed,
  onSessionExpired,
}: WorkoutPlayerProps): ReactNode => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const completionLocked = useRef(day.completed);
  const completionInFlight = useRef(false);
  const [completionState, setCompletionState] = useState<CompletionState>(
    day.completed ? 'completed' : 'idle',
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const presentation = directionPresentation[day.direction];
  const weekday = weekdayLongLabels[day.day_of_week] ?? '';
  const [savedSession, setSavedSession] = useState<WorkoutSessionResponse | null>(null);
  const [resumeVisible, setResumeVisible] = useState(true);
  const [positionStatus, setPositionStatus] = useState<string | null>(null);
  const positionGate = useRef(false);
  const lastSavedPosition = useRef(-1);
  const lastSaveAt = useRef(0);
  const hasPlayed = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void getWorkoutSession(day.video.id, programWeek, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setSavedSession(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPositionStatus('Позиция просмотра пока не загрузилась.');
      });
    return () => controller.abort();
  }, [day.video.id, programWeek]);
  const persistPosition = (force = false): void => {
    const video = videoRef.current;
    if (
      video === null ||
      !hasPlayed.current ||
      positionGate.current ||
      (!force && Date.now() - lastSaveAt.current < 10_000)
    )
      return;
    const position = Math.max(0, Math.min(86400, Math.floor(video.currentTime)));
    if (position === lastSavedPosition.current) return;
    positionGate.current = true;
    lastSaveAt.current = Date.now();
    void saveWorkoutSession(day.video.id, programWeek, { position_seconds: position })
      .then(() => {
        lastSavedPosition.current = position;
        if (mounted.current) setPositionStatus('Позиция просмотра сохранена');
      })
      .catch(() => {
        if (mounted.current) setPositionStatus('Позиция не сохранилась. Проверьте подключение.');
      })
      .finally(() => {
        positionGate.current = false;
      });
  };

  useEffect(() => {
    mounted.current = true;
    headingRef.current?.focus();

    return () => {
      mounted.current = false;
    };
  }, []);

  const markWorkoutComplete = useCallback(async (): Promise<void> => {
    if (completionLocked.current || completionInFlight.current) {
      return;
    }

    completionLocked.current = true;
    completionInFlight.current = true;
    onCompletionBusyChange(true);
    setCompletionState('saving');
    setErrorMessage(null);

    try {
      const response = await completeWorkout({
        video_id: day.video.id,
        program_week: programWeek,
      });

      if (mounted.current) {
        setCompletionState('completed');
      }
      onCompleted(response);
    } catch (error) {
      completionLocked.current = false;

      if (error instanceof ApiRequestError && error.kind === 'auth') {
        onSessionExpired();
        return;
      }

      if (mounted.current) {
        setCompletionState('failed');
        setErrorMessage(
          error instanceof ApiRequestError
            ? error.message
            : 'Не удалось отметить тренировку. Проверьте подключение и попробуйте ещё раз.',
        );
      }
    } finally {
      completionInFlight.current = false;
      onCompletionBusyChange(false);
    }
  }, [day.video.id, onCompleted, onCompletionBusyChange, onSessionExpired, programWeek]);

  const checkCompletion = useCallback(
    (forceComplete = false): void => {
      const video = videoRef.current;

      if (video === null || completionLocked.current) {
        return;
      }

      const measuredDuration = video.duration;
      const durationSeconds =
        Number.isFinite(measuredDuration) && measuredDuration > 0
          ? measuredDuration
          : day.duration_minutes * 60;
      const completionPercent =
        durationSeconds > 0 ? (Math.max(0, video.currentTime) / durationSeconds) * 100 : 0;

      if (forceComplete || completionPercent >= WORKOUT_COMPLETION_THRESHOLD) {
        void markWorkoutComplete();
      }
    },
    [day.duration_minutes, markWorkoutComplete],
  );

  useEffect(() => {
    if (day.video.video_url === null || day.completed) {
      return;
    }

    const timer = window.setInterval(() => checkCompletion(), WORKOUT_PROGRESS_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkCompletion, day.completed, day.video.video_url]);

  const closePlayer = useCallback((): void => {
    checkCompletion();

    if (completionInFlight.current) {
      return;
    }

    videoRef.current?.pause();
    onClosed();
  }, [checkCompletion, onClosed]);

  useEffect(() => {
    const handlePopState = (): void => checkCompletion();

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [checkCompletion]);

  return (
    <main
      className="workout-player-shell"
      data-testid="workout-player"
      aria-labelledby="workout-player-title"
      aria-busy={completionState === 'saving'}
    >
      <section className="workout-player-panel">
        <button
          className="workout-back"
          data-testid="workout-back"
          type="button"
          disabled={completionState === 'saving'}
          onClick={closePlayer}
        >
          <BackIcon />
          {completionState === 'saving' ? 'Сохраняем…' : 'Назад'}
        </button>

        <header className="workout-player-heading">
          <h1 id="workout-player-title" ref={headingRef} tabIndex={-1}>
            {day.title}
          </h1>
          <p>
            <span aria-hidden="true">{presentation.icon}</span>
            <span>·</span>
            <span>{day.duration_minutes} мин</span>
            <span>·</span>
            <span>{weekday}</span>
          </p>
        </header>

        <div className="workout-player-frame">
          {day.video.video_url === null ? (
            <div
              className="workout-video-placeholder"
              data-testid="workout-video-placeholder"
              role="status"
            >
              <PlaceholderPlayIcon />
              <strong>Видео скоро будет доступно</strong>
              <span>Мы добавим тренировку перед стартом</span>
            </div>
          ) : (
            <video
              ref={videoRef}
              className="workout-video"
              data-testid="workout-video"
              src={day.video.video_url}
              poster={day.video.poster_url ?? undefined}
              controls
              playsInline
              preload="metadata"
              aria-label={`Видео тренировки «${presentation.label}»`}
              onPlay={() => {
                hasPlayed.current = true;
                setResumeVisible(false);
              }}
              onTimeUpdate={() => {
                checkCompletion();
                persistPosition();
              }}
              onPause={() => {
                checkCompletion();
                persistPosition(true);
              }}
              onEnded={() => checkCompletion(true)}
              onError={() =>
                setErrorMessage(
                  'Не удалось загрузить видео. Попробуйте открыть тренировку ещё раз.',
                )
              }
            />
          )}
        </div>

        {savedSession !== null &&
          savedSession.position_seconds > 5 &&
          resumeVisible &&
          !day.completed && (
            <button
              className="primary-button workout-resume"
              type="button"
              onClick={() => {
                const video = videoRef.current;
                if (video !== null) {
                  video.currentTime = Number.isFinite(video.duration)
                    ? Math.min(savedSession.position_seconds, Math.max(0, video.duration - 1))
                    : savedSession.position_seconds;
                  setResumeVisible(false);
                  void video.play().catch(() => undefined);
                }
              }}
            >
              Продолжить с {formatWorkoutTime(savedSession.position_seconds)}
            </button>
          )}
        {positionStatus !== null && <p className="workout-position-status">{positionStatus}</p>}
        {onAskTrainer !== undefined && (
          <button
            className="secondary-button workout-ask"
            type="button"
            disabled={completionState === 'saving'}
            onClick={() => {
              videoRef.current?.pause();
              if (!completionInFlight.current)
                onAskTrainer(day, programWeek, videoRef.current?.currentTime ?? 0);
            }}
          >
            Спросить тренера об этом моменте ↗
          </button>
        )}
        {savedSession !== null && (
          <section className="workout-guide">
            <h2>Перед началом</h2>
            <p>
              {savedSession.guide.equipment.length > 0
                ? `Инвентарь: ${savedSession.guide.equipment.join(', ')}`
                : 'Инвентарь пока не указан. Посмотрите описание и начало видео.'}
            </p>
            {savedSession.guide.technique && (
              <p className="workout-technique">{savedSession.guide.technique}</p>
            )}
            {savedSession.guide.chapters.length > 0 && (
              <div className="workout-chapters" aria-label="Разделы тренировки">
                {savedSession.guide.chapters.map((chapter) => (
                  <button
                    className="secondary-button"
                    type="button"
                    key={chapter.start_seconds}
                    onClick={() => {
                      const video = videoRef.current;
                      if (video !== null) {
                        video.currentTime = chapter.start_seconds;
                        void video.play().catch(() => undefined);
                      }
                    }}
                  >
                    {formatWorkoutTime(chapter.start_seconds)} · {chapter.title}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {completionState === 'failed' && (
          <button
            type="button"
            className="primary-button"
            onClick={() => void markWorkoutComplete()}
          >
            Повторить сохранение тренировки
          </button>
        )}
        {completionState === 'completed' ? (
          <p className="workout-completion-message" role="status">
            <KineticMark completed /> Тренировка пройдена · результат сохранён
          </p>
        ) : null}

        {completionState === 'completed' && savedSession !== null && (
          <WorkoutFeedback
            videoId={day.video.id}
            week={programWeek}
            initialDifficulty={savedSession.difficulty}
            initialWellbeing={savedSession.wellbeing}
            initialNote={savedSession.note}
          />
        )}
        {errorMessage === null ? null : (
          <p className="workout-player-error" role="alert">
            {errorMessage}
          </p>
        )}

        {day.description === null ? null : (
          <p className="workout-player-description">{day.description}</p>
        )}
      </section>
    </main>
  );
};
