import React, { type CSSProperties, type ReactNode } from 'react';
import type { ProgramDay, WeekResponse } from '@kinetra/shared';

import {
  directionPresentation,
  isProgramWeekLocked,
  maximumAccessibleWeek,
  weekdayShortLabels,
  weekProgressPercent,
  workoutCardState,
  type WorkoutCardState,
} from './model';

const NavigationArrowIcon = ({
  direction,
}: {
  readonly direction: 'previous' | 'next';
}): ReactNode =>
  React.createElement(
    'svg',
    { className: 'program-navigation-icon', viewBox: '0 0 24 24', 'aria-hidden': true },
    React.createElement('path', {
      d: direction === 'previous' ? 'm15 5-7 7 7 7' : 'm9 5 7 7-7 7',
    }),
  );

const WorkoutStatusIcon = ({
  state,
  preparationRequired,
}: {
  readonly state: WorkoutCardState;
  readonly preparationRequired: boolean;
}): ReactNode => {
  if (state === 'completed') {
    return (
      <svg className="workout-status-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12.3 2.5 2.5 5.5-6" />
      </svg>
    );
  }

  if (state === 'locked' || preparationRequired) {
    return (
      <svg className="workout-status-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5.5" y="10" width="13" height="10" rx="2" />
        <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
      </svg>
    );
  }

  return (
    <svg className="workout-status-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path className="workout-status-play" d="m10 8 6 4-6 4Z" />
    </svg>
  );
};

const statusCopy = (state: WorkoutCardState, preparationRequired: boolean): string => {
  if (state === 'completed') {
    return 'Пройдено';
  }

  if (state === 'locked') {
    return 'Заблокировано';
  }

  return preparationRequired ? 'После подготовки' : 'Доступно';
};

interface WorkoutCardProps {
  readonly day: ProgramDay;
  readonly state: WorkoutCardState;
  readonly isToday: boolean;
  readonly interactionDisabled: boolean;
  readonly preparationRequired: boolean;
  readonly onSelect: (day: ProgramDay) => void;
}

const WorkoutCard = ({
  day,
  state,
  isToday,
  interactionDisabled,
  preparationRequired,
  onSelect,
}: WorkoutCardProps): ReactNode => {
  const presentation = directionPresentation[day.direction];
  const weekday = weekdayShortLabels[day.day_of_week] ?? String(day.day_of_week);
  const stateLabel = statusCopy(state, preparationRequired);
  const disabled = state === 'locked' || interactionDisabled;
  const className = [
    'workout-card',
    `is-${state}`,
    preparationRequired ? 'requires-preparation' : '',
    isToday ? 'is-today' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li>
      <button
        className={className}
        data-testid={`workout-card-${day.day_of_week}`}
        data-today={isToday ? 'true' : undefined}
        data-training-access={preparationRequired ? 'base-lessons-required' : undefined}
        type="button"
        disabled={disabled}
        aria-label={`${weekday}. ${presentation.label}. ${day.duration_minutes} мин. ${stateLabel}${isToday ? '. Сегодня' : ''}`}
        onClick={() => onSelect(day)}
      >
        <span className="workout-day">{weekday}</span>
        <span className="workout-card-copy">
          <span className="workout-card-primary">
            <span className="workout-direction-icon" aria-hidden="true">
              {presentation.icon}
            </span>
            <strong>{presentation.label}</strong>
            <span className="workout-separator" aria-hidden="true">
              ·
            </span>
            <span>{day.duration_minutes} мин</span>
          </span>
          {isToday ? (
            <span className="workout-today-link" data-testid="today-workout" aria-hidden="true">
              Сегодня
              <span>›</span>
            </span>
          ) : null}
        </span>
        <span
          className="workout-status"
          data-testid={`workout-status-${day.day_of_week}`}
          data-state={preparationRequired ? 'preparation-required' : state}
        >
          <WorkoutStatusIcon state={state} preparationRequired={preparationRequired} />
          <span>{stateLabel}</span>
        </span>
      </button>
    </li>
  );
};

export interface ProgramWeekViewProps {
  readonly response: WeekResponse;
  readonly currentWeekNumber: number;
  readonly todayDayOfWeek: number;
  readonly isNavigating: boolean;
  readonly navigationError: string | null;
  readonly trainingLocked?: boolean;
  readonly completedBaseLessons?: number | null;
  readonly baseLessonUnlockThreshold?: number | null;
  readonly preparationLoading?: boolean;
  readonly preparationError?: string | null;
  readonly onOpenBaseLessons?: () => void;
  readonly onRetryPreparation?: () => void;
  readonly onPreviousWeek: () => void;
  readonly onNextWeek: () => void;
  readonly onSelectWorkout: (day: ProgramDay) => void;
}

export const ProgramWeekView = ({
  response,
  currentWeekNumber,
  todayDayOfWeek,
  isNavigating,
  navigationError,
  trainingLocked = false,
  completedBaseLessons = null,
  baseLessonUnlockThreshold = null,
  preparationLoading = false,
  preparationError = null,
  onOpenBaseLessons,
  onRetryPreparation,
  onPreviousWeek,
  onNextWeek,
  onSelectWorkout,
}: ProgramWeekViewProps): ReactNode => {
  const { week } = response;
  const weekLocked = isProgramWeekLocked(response, currentWeekNumber);
  const canGoPrevious = week.week_number > 1;
  const canGoNext =
    week.week_number < maximumAccessibleWeek(currentWeekNumber, response.total_weeks);
  const progressPercent = weekProgressPercent(week.days_completed, week.total_days);
  const progressStyle = { width: `${progressPercent}%` } satisfies CSSProperties;

  return (
    <main
      className="program-shell"
      data-testid="main-screen"
      aria-labelledby="program-week-heading"
      aria-busy={isNavigating}
    >
      <section className="program-panel">
        {trainingLocked && onOpenBaseLessons !== undefined ? (
          <section
            className="training-preparation-card"
            data-testid="training-preparation-card"
            aria-labelledby="training-preparation-title"
          >
            <div className="training-preparation-copy">
              <p className="program-kicker">ПЕРВАЯ ТРЕНИРОВКА</p>
              <h2 id="training-preparation-title">Подготовьтесь в удобном темпе</h2>
              <p>
                Вы можете свободно изучать Kinetra. Для запуска первой тренировки нужно сначала
                пройти базовые уроки.
              </p>
              <p
                className="training-preparation-progress"
                data-testid="training-preparation-progress"
              >
                {preparationLoading
                  ? 'Загружаем прогресс…'
                  : completedBaseLessons !== null && baseLessonUnlockThreshold !== null
                    ? `Пройдено ${completedBaseLessons} из ${baseLessonUnlockThreshold} необходимых`
                    : 'Пройдите минимум 4 базовых урока'}
              </p>
              {preparationError === null ? null : (
                <div className="training-preparation-error" role="status">
                  <span>{preparationError}</span>
                  {onRetryPreparation === undefined ? null : (
                    <button type="button" onClick={onRetryPreparation}>
                      Повторить
                    </button>
                  )}
                </div>
              )}
            </div>
            <button
              className="primary-button training-preparation-action"
              data-testid="preparation-open-base-lessons"
              type="button"
              onClick={onOpenBaseLessons}
            >
              Пройти базовые уроки
            </button>
          </section>
        ) : null}

        <header className="program-week-header">
          <button
            className="program-week-arrow"
            data-testid="week-previous"
            type="button"
            aria-label="Предыдущая неделя"
            disabled={!canGoPrevious || isNavigating}
            onClick={onPreviousWeek}
          >
            <NavigationArrowIcon direction="previous" />
          </button>
          <h1 id="program-week-heading" data-testid="week-heading">
            Неделя {week.week_number}
          </h1>
          <button
            className="program-week-arrow"
            data-testid="week-next"
            type="button"
            aria-label="Следующая неделя"
            disabled={!canGoNext || isNavigating}
            onClick={onNextWeek}
          >
            <NavigationArrowIcon direction="next" />
          </button>
        </header>

        <section className="program-week-progress-wrap" aria-label="Прогресс недели">
          <span className="program-week-progress-copy">
            {week.days_completed}/{week.total_days}
          </span>
          <div
            className="program-week-progress"
            data-testid="week-progress"
            role="progressbar"
            aria-label="Прогресс недели"
            aria-valuemin={0}
            aria-valuemax={week.total_days}
            aria-valuenow={week.days_completed}
            aria-valuetext={`Пройдено ${week.days_completed} из ${week.total_days}`}
          >
            <span style={progressStyle} />
          </div>
        </section>

        {navigationError === null ? null : (
          <p className="program-navigation-error" role="alert">
            {navigationError}
          </p>
        )}

        <ol className="workout-list" aria-label={`Тренировки недели ${week.week_number}`}>
          {week.days.map((day) => (
            <WorkoutCard
              key={day.id}
              day={day}
              state={workoutCardState(day, weekLocked)}
              interactionDisabled={isNavigating}
              preparationRequired={
                trainingLocked && workoutCardState(day, weekLocked) === 'available'
              }
              isToday={
                !weekLocked &&
                week.week_number === currentWeekNumber &&
                day.day_of_week === todayDayOfWeek
              }
              onSelect={onSelectWorkout}
            />
          ))}
        </ol>
      </section>
    </main>
  );
};
