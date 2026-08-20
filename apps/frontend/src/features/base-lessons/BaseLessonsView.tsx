import React, { useState, type CSSProperties, type ReactNode } from 'react';
import type { BaseLesson, BaseLessonsResponse } from '@kinetra/shared';

import {
  baseProgramActionLabel,
  clampCompletionPercent,
  completionStateForProgress,
  formatLessonDuration,
  overallProgressPercent,
} from './model';

const PlayIcon = (): ReactNode =>
  React.createElement(
    'svg',
    { viewBox: '0 0 24 24', 'aria-hidden': true },
    React.createElement('path', { d: 'm9 6 9 6-9 6Z' }),
  );

const CompletedIcon = (): ReactNode => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m6.5 12.5 3.4 3.4 7.6-8" />
  </svg>
);

const LessonPoster = ({ lesson }: { readonly lesson: BaseLesson }): ReactNode => {
  const [imageFailed, setImageFailed] = useState(false);
  const showPlaceholder = lesson.poster_url === null || imageFailed;

  return (
    <span className="base-lesson-poster" aria-hidden="true">
      {showPlaceholder ? (
        <span className="base-lesson-poster-placeholder">
          <PlayIcon />
        </span>
      ) : (
        <img
          src={lesson.poster_url ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      )}
      <span className="base-lesson-order">{String(lesson.order_index).padStart(2, '0')}</span>
    </span>
  );
};

const LessonStatus = ({ lesson }: { readonly lesson: BaseLesson }): ReactNode => {
  const state = completionStateForProgress(lesson.progress);
  const completionPercent = clampCompletionPercent(lesson.progress.completion_percent);

  if (state === 'completed') {
    return (
      <span
        className="base-lesson-status is-completed"
        data-testid={`base-lesson-status-${lesson.order_index}`}
        data-state="completed"
      >
        <CompletedIcon />
        <span>Пройден</span>
      </span>
    );
  }

  if (state === 'in_progress') {
    const progressStyle = { width: `${completionPercent}%` } satisfies CSSProperties;

    return (
      <span
        className="base-lesson-status is-progress"
        data-testid={`base-lesson-status-${lesson.order_index}`}
        data-state="in-progress"
      >
        <span className="visually-hidden">Пройдено {Math.round(completionPercent)}%</span>
        <span className="base-lesson-card-progress" aria-hidden="true">
          <span style={progressStyle} />
        </span>
        <span aria-hidden="true">{Math.round(completionPercent)}%</span>
      </span>
    );
  }

  return (
    <span
      className="base-lesson-status is-empty"
      data-testid={`base-lesson-status-${lesson.order_index}`}
      data-state="not-started"
    >
      <span className="base-lesson-empty-circle" aria-hidden="true" />
      <span>Не начат</span>
    </span>
  );
};

const accessibleLessonStatus = (lesson: BaseLesson): string => {
  const state = completionStateForProgress(lesson.progress);

  if (state === 'completed') {
    return 'Пройден';
  }

  if (state === 'in_progress') {
    return `Пройдено ${Math.round(clampCompletionPercent(lesson.progress.completion_percent))}%`;
  }

  return 'Не начат';
};

export interface BaseLessonsViewProps {
  readonly response: BaseLessonsResponse;
  readonly isCompleting: boolean;
  readonly errorMessage: string | null;
  readonly onSelectLesson: (lessonId: string) => void;
  readonly onComplete: () => void;
  readonly onOpenSettings: () => void;
}

export const BaseLessonsView = ({
  response,
  isCompleting,
  errorMessage,
  onSelectLesson,
  onComplete,
  onOpenSettings,
}: BaseLessonsViewProps): ReactNode => {
  const lessonCount = response.lessons.length;
  const progressPercent = overallProgressPercent(response.total_completed, lessonCount);
  const progressStyle = { width: `${progressPercent}%` } satisfies CSSProperties;
  const actionLabel = baseProgramActionLabel(response.total_completed, response.unlock_threshold);

  return (
    <main
      className="base-lessons-shell"
      data-testid="base-lessons-screen"
      aria-labelledby="base-lessons-title"
      aria-busy={isCompleting}
    >
      <section className="base-lessons-panel">
        <header className="base-lessons-topbar">
          <div className="survey-brand">
            <span className="survey-brand-mark" aria-hidden="true">
              K
            </span>
            <span>KINETRA</span>
          </div>
          <button
            className="ghost-button base-lessons-settings"
            data-testid="open-settings"
            type="button"
            disabled={isCompleting}
            onClick={onOpenSettings}
          >
            Настройки
          </button>
        </header>

        <div className="base-lessons-heading">
          <h1 id="base-lessons-title">Базовые движения</h1>
          <p>Изучите основы, чтобы тренировки были безопасными и эффективными</p>
        </div>

        <section className="base-lessons-overview" aria-labelledby="base-lessons-progress-copy">
          <div className="base-lessons-progress-copy" id="base-lessons-progress-copy">
            <span>
              Пройдено {response.total_completed} из {lessonCount}
            </span>
            <strong>{Math.round(progressPercent)}%</strong>
          </div>
          <div
            className="base-lessons-progress"
            data-testid="base-lessons-progress"
            role="progressbar"
            aria-label="Прогресс базовых уроков"
            aria-valuemin={0}
            aria-valuemax={lessonCount}
            aria-valuenow={response.total_completed}
            aria-valuetext={`Пройдено ${response.total_completed} из ${lessonCount}`}
          >
            <span style={progressStyle} />
          </div>
          <p id="base-lessons-unlock-hint">
            Пройдите минимум {response.unlock_threshold} урока, чтобы открыть программу тренировок
          </p>
        </section>

        <ol className="base-lessons-list" aria-label="Список базовых уроков">
          {response.lessons.map((lesson) => (
            <li key={lesson.id}>
              <button
                className="base-lesson-card"
                data-testid={`base-lesson-card-${lesson.order_index}`}
                type="button"
                aria-label={`Открыть урок ${lesson.order_index}: ${lesson.title}. ${formatLessonDuration(lesson.duration_seconds)}. ${accessibleLessonStatus(lesson)}`}
                onClick={() => onSelectLesson(lesson.id)}
              >
                <LessonPoster lesson={lesson} />
                <span className="base-lesson-copy">
                  <strong>{lesson.title}</strong>
                  <span className="base-lesson-meta">
                    <span>{formatLessonDuration(lesson.duration_seconds)}</span>
                    <LessonStatus lesson={lesson} />
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <footer className="base-lessons-fixed-action">
        {errorMessage === null ? null : (
          <p className="base-lessons-action-error" role="alert">
            {errorMessage}
          </p>
        )}
        <button
          className="primary-button base-lessons-complete"
          data-testid="base-lessons-complete"
          type="button"
          disabled={!response.program_unlocked || isCompleting}
          aria-describedby="base-lessons-unlock-hint"
          onClick={onComplete}
        >
          {isCompleting ? 'Открываем программу…' : actionLabel}
        </button>
      </footer>
    </main>
  );
};
