import React, { type CSSProperties, type ReactNode } from 'react';
import type { ProgramDay, WeekResponse } from '@kinetra/shared';

import {
  directionPresentation,
  isProgramWeekLocked,
  weekdayShortLabels,
  weekProgressPercent,
  workoutCardState,
  type WorkoutCardState,
} from './model';

const TodayHeading = (): ReactNode =>
  React.createElement(
    'h1',
    { id: 'program-today-heading', 'data-testid': 'today-heading' },
    'Сегодня',
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
        aria-label={`${weekday}. ${day.title}. ${day.duration_minutes} мин. ${stateLabel}${isToday ? '. Сегодня' : ''}`}
        onClick={() => onSelect(day)}
      >
        <span className="workout-day">{weekday}</span>
        <span className="workout-card-copy">
          <span className="workout-card-primary">
            <span className="workout-direction-icon" aria-hidden="true">
              {day.icon || presentation.icon}
            </span>
            <strong>{day.title}</strong>
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
  readonly onOpenSchedule: () => void;
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
  onOpenSchedule,
  onSelectWorkout,
}: ProgramWeekViewProps): ReactNode => {
  const { week } = response;
  const weekLocked = isProgramWeekLocked(response, currentWeekNumber);
  const progressPercent = weekProgressPercent(week.days_completed, week.total_days);
  const progressStyle = { width: `${progressPercent}%` } satisfies CSSProperties;
  const currentWeekVisible = week.week_number === currentWeekNumber;
  const todayWorkout = currentWeekVisible
    ? week.days.find(({ day_of_week: dayOfWeek }) => dayOfWeek === todayDayOfWeek)
    : undefined;
  const nextWorkout = currentWeekVisible
    ? [...week.days]
        .sort((left, right) => left.day_of_week - right.day_of_week)
        .find(({ completed, day_of_week: dayOfWeek }) => !completed && dayOfWeek > todayDayOfWeek)
    : undefined;

  return (
    <main
      className="program-shell"
      data-testid="main-screen"
      aria-labelledby="program-today-heading"
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

        <header className="program-today-header">
          <p className="program-kicker">ПРОТОКОЛ ДНЯ · НЕДЕЛЯ {currentWeekNumber}</p>
          <TodayHeading />
          <p>Текущая тренировка, прогресс недели и ближайший следующий шаг.</p>
        </header>

        <section
          className="program-week-progress-wrap program-today-progress"
          aria-label="Прогресс недели"
        >
          <span className="program-week-progress-copy">Прогресс недели</span>
          <strong data-testid="week-progress-copy">
            {week.days_completed} из {week.total_days}
          </strong>
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

        <section className="program-today-section" aria-labelledby="today-workout-heading">
          <div className="program-today-section-heading">
            <h2 id="today-workout-heading">Тренировка на сегодня</h2>
            <span>{weekdayShortLabels[todayDayOfWeek] ?? ''}</span>
          </div>
          {todayWorkout === undefined ? (
            <div className="program-today-rest" data-testid="today-rest-day" role="status">
              <strong>Сегодня по плану отдых</strong>
              <span>Восстановление — такая же важная часть программы, как тренировки.</span>
            </div>
          ) : (
            <ol
              className="workout-list program-today-workout-list"
              aria-label="Тренировка на сегодня"
            >
              <WorkoutCard
                day={todayWorkout}
                state={workoutCardState(todayWorkout, weekLocked)}
                interactionDisabled={isNavigating}
                preparationRequired={
                  trainingLocked && workoutCardState(todayWorkout, weekLocked) === 'available'
                }
                isToday
                onSelect={onSelectWorkout}
              />
            </ol>
          )}
        </section>

        <section
          className="program-today-section program-next-section"
          data-testid="next-workout"
          aria-labelledby="next-workout-heading"
        >
          <div className="program-today-section-heading">
            <h2 id="next-workout-heading">Следующая тренировка</h2>
          </div>
          {nextWorkout === undefined ? (
            <p className="program-next-empty">
              На этой неделе больше тренировок нет. Следующую неделю можно посмотреть в расписании.
            </p>
          ) : (
            <ol
              className="workout-list program-next-workout-list"
              aria-label="Следующая тренировка"
            >
              <WorkoutCard
                day={nextWorkout}
                state={workoutCardState(nextWorkout, weekLocked)}
                interactionDisabled={isNavigating}
                preparationRequired={
                  trainingLocked && workoutCardState(nextWorkout, weekLocked) === 'available'
                }
                isToday={false}
                onSelect={onSelectWorkout}
              />
            </ol>
          )}
        </section>

        <button
          className="secondary-button program-schedule-action"
          data-testid="today-open-schedule"
          type="button"
          onClick={onOpenSchedule}
        >
          Открыть полное расписание
        </button>
      </section>
    </main>
  );
};
