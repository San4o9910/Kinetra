import React, { type ReactNode } from 'react';
import type { ProgressResponse } from '@kinetra/shared';
import { journeySummary, PROGRAM_WEEKS, PROGRAM_WORKOUTS } from './journey';

export const ProgressJourney = ({
  response,
}: {
  readonly response: ProgressResponse;
}): ReactNode => {
  const summary = journeySummary(response.stats.total_workouts, response.metrics.current_week);
  return (
    <React.Fragment>
      <section
        className="progress-section progress-journey"
        data-testid="progress-journey"
        aria-labelledby="progress-journey-heading"
      >
        <p className="progress-eyebrow">КАЖДЫЙ ШАГ ИМЕЕТ ЗНАЧЕНИЕ</p>
        <div className="progress-section-heading">
          <h2 id="progress-journey-heading">Путь на 12 недель</h2>
          <span className="progress-journey-count">
            <strong>{summary.completed}</strong> / {PROGRAM_WORKOUTS} тренировок
          </span>
        </div>
        <progress
          className="progress-journey-bar"
          max={PROGRAM_WORKOUTS}
          value={summary.completed}
          aria-label="Завершённые тренировки программы"
        >
          {summary.completed} из {PROGRAM_WORKOUTS}
        </progress>
        <ol className="progress-journey-weeks" aria-label="Недели программы">
          {Array.from({ length: PROGRAM_WEEKS }, (_, index) => index + 1).map((week) => (
            <li
              key={week}
              className={week === summary.currentWeek ? 'is-current' : ''}
              aria-current={week === summary.currentWeek ? 'step' : undefined}
            >
              <span className="visually-hidden">Неделя </span>
              {String(week).padStart(2, '0')}
            </li>
          ))}
        </ol>
        <p className="progress-support-copy">
          Выделена текущая неделя программы. Полностью завершено недель:{' '}
          {response.stats.total_weeks_completed}.
        </p>
      </section>
    </React.Fragment>
  );
};
