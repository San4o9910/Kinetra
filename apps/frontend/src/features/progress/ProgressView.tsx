import React, { type ReactNode } from 'react';
import type { LockedAchievement, ProgressResponse, UnlockedAchievement } from '@kinetra/shared';

import { ProgressLineChart } from './ProgressLineChart';
import {
  formatAchievementDate,
  formatStreakDays,
  formatTrainingMinutes,
  progressMetricConfigs,
  type ProgressMetricKey,
} from './model';

export interface ProgressViewProps {
  readonly response: ProgressResponse;
  readonly timezone: string;
  readonly selectedMetric: ProgressMetricKey;
  readonly onMetricChange: (metric: ProgressMetricKey) => void;
  readonly onEditGoal: () => void;
  readonly onOpenWeeklyMetrics: () => void;
}

const UnlockedAchievementRow = ({
  achievement,
  timezone,
}: {
  readonly achievement: UnlockedAchievement;
  readonly timezone: string;
}): ReactNode => (
  <li
    className="progress-achievement-row is-unlocked"
    data-testid={`progress-achievement-${achievement.code}`}
    data-state="unlocked"
  >
    <span className="progress-achievement-icon" aria-hidden="true">
      {achievement.icon_key}
    </span>
    <span className="progress-achievement-copy">
      <strong>{achievement.title}</strong>
      <span>{achievement.description}</span>
      <time dateTime={achievement.unlocked_at}>
        Получено {formatAchievementDate(achievement.unlocked_at, timezone)}
      </time>
    </span>
    <span className="progress-achievement-check" role="img" aria-label="Разблокировано">
      ✓
    </span>
  </li>
);

const LockedAchievementRow = ({
  achievement,
}: {
  readonly achievement: LockedAchievement;
}): ReactNode => (
  <li
    className="progress-achievement-row is-locked"
    data-testid={`progress-achievement-${achievement.code}`}
    data-state="locked"
  >
    <span className="progress-achievement-icon" aria-hidden="true">
      {achievement.icon_key}
    </span>
    <span className="progress-achievement-copy">
      <strong>{achievement.title}</strong>
      <span>{achievement.description}</span>
      <span className="visually-hidden">Заблокировано.</span>
    </span>
    <span className="progress-achievement-value">
      <span className="visually-hidden">Прогресс </span>
      {achievement.progress}
    </span>
  </li>
);

export const ProgressView = ({
  response,
  timezone,
  selectedMetric,
  onMetricChange,
  onEditGoal,
  onOpenWeeklyMetrics,
}: ProgressViewProps): ReactNode => {
  const activeMetric =
    progressMetricConfigs.find((metric) => metric.key === selectedMetric) ??
    progressMetricConfigs[0];
  const stats = [
    {
      key: 'total-workouts',
      icon: '🏋️',
      label: 'Тренировок',
      value: String(response.stats.total_workouts),
    },
    {
      key: 'weeks',
      icon: '📅',
      label: 'Недель пройдено',
      value: String(response.stats.total_weeks_completed),
    },
    {
      key: 'current-streak',
      icon: '🔥',
      label: 'Текущая серия',
      value: formatStreakDays(response.stats.current_streak),
    },
    {
      key: 'best-streak',
      icon: '⭐',
      label: 'Лучшая серия',
      value: formatStreakDays(response.stats.best_streak),
    },
    {
      key: 'minutes',
      icon: '⏱',
      label: 'Общее время',
      value: formatTrainingMinutes(response.stats.total_minutes_trained),
    },
  ] as const;

  return (
    <React.Fragment>
      <main
        className="progress-shell"
        data-testid="progress-screen"
        aria-labelledby="progress-heading"
      >
        <div className="progress-panel">
          <header className="progress-header">
            <h1 id="progress-heading">Прогресс</h1>
          </header>

          <section
            className="progress-section progress-goal-section"
            data-testid="progress-goal-section"
            aria-labelledby="progress-goal-heading"
          >
            <h2 id="progress-goal-heading">Моя цель</h2>
            <div className="progress-goal-card">
              <p data-testid="progress-goal-label">{response.goal.goal_label}</p>
              <button
                className="progress-outline-button"
                data-testid="progress-edit-goal"
                type="button"
                onClick={onEditGoal}
              >
                Изменить цель
              </button>
            </div>
          </section>

          <section
            className="progress-section progress-metrics-section"
            data-testid="progress-metrics-section"
            aria-labelledby="progress-metrics-heading"
          >
            <div className="progress-section-heading">
              <h2 id="progress-metrics-heading" tabIndex={-1}>
                Как вы себя чувствуете?
              </h2>
              {response.metrics.pending_survey ? (
                <button
                  className="primary-button progress-weekly-button"
                  data-testid="progress-weekly-open"
                  type="button"
                  onClick={onOpenWeeklyMetrics}
                >
                  Оценить неделю
                </button>
              ) : null}
            </div>
            <div className="progress-metric-switch" role="group" aria-label="Показатель графика">
              {progressMetricConfigs.map((metric) => (
                <button
                  key={metric.key}
                  className={selectedMetric === metric.key ? 'is-active' : ''}
                  data-testid={`progress-chart-tab-${metric.testId}`}
                  type="button"
                  aria-pressed={selectedMetric === metric.key}
                  aria-label={metric.accessibleLabel}
                  onClick={() => onMetricChange(metric.key)}
                >
                  {metric.label}
                </button>
              ))}
            </div>
            <ProgressLineChart history={response.metrics.history} metric={activeMetric} />
          </section>

          <section
            className="progress-section progress-stats-section"
            data-testid="progress-stats-section"
            aria-labelledby="progress-stats-heading"
          >
            <h2 id="progress-stats-heading">Ваши достижения в цифрах</h2>
            <dl className="progress-stats-grid">
              {stats.map((stat) => (
                <div key={stat.key} data-testid={`progress-stat-${stat.key}`}>
                  <dt>
                    <span className="progress-stat-icon" aria-hidden="true">
                      {stat.icon}
                    </span>
                    <span>{stat.label}</span>
                  </dt>
                  <dd>{stat.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section
            className="progress-section progress-achievements-section"
            data-testid="progress-achievements-section"
            aria-labelledby="progress-achievements-heading"
          >
            <div className="progress-achievements-heading">
              <h2 id="progress-achievements-heading">Достижения</h2>
              <span data-testid="progress-achievement-count">
                {response.achievements.total_unlocked}/{response.achievements.total_available}
              </span>
            </div>
            <ul className="progress-achievement-list">
              {response.achievements.unlocked.map((achievement) => (
                <UnlockedAchievementRow
                  key={achievement.code}
                  achievement={achievement}
                  timezone={timezone}
                />
              ))}
              {response.achievements.locked.map((achievement) => (
                <LockedAchievementRow key={achievement.code} achievement={achievement} />
              ))}
            </ul>
          </section>
        </div>
      </main>
    </React.Fragment>
  );
};
