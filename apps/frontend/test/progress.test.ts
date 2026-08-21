import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProgressResponse, SurveyGoal, WeeklyMetric } from '@kinetra/shared';

import { GoalDialog, WeeklyMetricsDialog } from '../src/features/progress/ProgressDialogs.js';
import { ProgressLineChart } from '../src/features/progress/ProgressLineChart.js';
import { ProgressView } from '../src/features/progress/ProgressView.js';
import {
  clampMetricScore,
  formatAchievementDate,
  formatStreakDays,
  formatTrainingMinutes,
  goalOptions,
  normalizedNote,
  progressGoalLabels,
  progressMetricConfigs,
  withUpdatedGoal,
  withUpdatedMetrics,
} from '../src/features/progress/model.js';

const metrics: readonly WeeklyMetric[] = [
  {
    program_week: 1,
    energy: 6,
    sleep: 5,
    mood: 7,
    body_satisfaction: 5,
    note: 'Было тяжело, но интересно',
    created_at: '2026-08-03T18:00:00.000Z',
  },
  {
    program_week: 2,
    energy: 7,
    sleep: 6,
    mood: 7,
    body_satisfaction: 6,
    note: null,
    created_at: '2026-08-10T18:00:00.000Z',
  },
];

const response: ProgressResponse = {
  goal: {
    current_goal: 'general_health',
    goal_label: progressGoalLabels.general_health,
    set_at: '2026-07-20T10:00:00.000Z',
  },
  params: {
    gender: 'male',
    age_range: '26-35',
    experience: 'novice',
    injuries: ['knees', 'other'],
    survey_updated_at: '2026-07-20T10:00:00.000Z',
  },
  metrics: {
    current_week: 3,
    history: metrics,
    pending_survey: true,
  },
  achievements: {
    unlocked: [
      {
        code: 'first_base_lesson',
        title: 'Первый шаг',
        description: 'Просмотрен первый базовый урок',
        icon_key: '🎯',
        unlocked_at: '2026-08-10T23:30:00.000Z',
      },
    ],
    locked: [
      {
        code: 'first_workout',
        title: 'Первая тренировка',
        description: 'Первая тренировка из программы',
        icon_key: '💪',
        progress: '0/1',
      },
    ],
    total_unlocked: 2,
    total_available: 5,
  },
  stats: {
    total_workouts: 15,
    total_weeks_completed: 2,
    current_streak: 3,
    best_streak: 5,
    total_minutes_trained: 450,
  },
};

const renderProgress = (
  fixture: ProgressResponse = response,
  selectedMetric: (typeof progressMetricConfigs)[number]['key'] = 'energy',
): string =>
  renderToStaticMarkup(
    createElement(ProgressView, {
      response: fixture,
      timezone: 'Europe/Moscow',
      selectedMetric,
      onMetricChange: () => undefined,
      onEditGoal: () => undefined,
      onOpenWeeklyMetrics: () => undefined,
    }),
  );

test('T09 progress view renders exactly four dashboard sections and aggregate data', () => {
  const markup = renderProgress();

  assert.equal((markup.match(/data-testid="progress-[^"]+-section"/gu) ?? []).length, 4);
  for (const testId of ['goal', 'metrics', 'stats', 'achievements']) {
    assert.ok(markup.includes(`data-testid="progress-${testId}-section"`));
  }

  assert.ok(markup.includes(progressGoalLabels.general_health));
  assert.ok(markup.includes('data-testid="progress-weekly-open"'));
  assert.equal((markup.match(/data-testid="progress-stat-[^"]+"/gu) ?? []).length, 5);
  assert.ok(markup.includes('7ч 30мин'));
  assert.ok(markup.includes('3 дня'));
  assert.ok(markup.includes('5 дней'));
  assert.ok(markup.includes('data-testid="progress-achievement-count">2/5'));
  assert.ok(markup.includes('data-state="unlocked"'));
  assert.ok(markup.includes('data-state="locked"'));
  assert.ok(markup.includes('Получено 11.08.2026'));
  assert.ok(markup.includes('0/1'));
});

test('all server goal codes have exact user-facing labels', () => {
  const expected: Readonly<Record<SurveyGoal, string>> = {
    flexibility: 'Хочу быть гибким и подвижным',
    strength: 'Хочу стать сильнее и выносливее',
    awareness: 'Хочу лучше чувствовать своё тело',
    general_health: 'Хочу поддерживать форму и здоровье',
  };

  assert.deepEqual(progressGoalLabels, expected);
  assert.deepEqual(
    goalOptions,
    Object.entries(expected).map(([value, label]) => ({ value, label })),
  );
});

test('chart uses an exact placeholder before two weeks and an accessible SVG afterwards', () => {
  const emptyMarkup = renderToStaticMarkup(
    createElement(ProgressLineChart, {
      history: metrics.slice(0, 1),
      metric: progressMetricConfigs[0],
    }),
  );
  assert.ok(
    emptyMarkup.includes('Заполните самооценку минимум за 2 недели, чтобы увидеть динамику'),
  );
  assert.equal(emptyMarkup.includes('<svg'), false);

  for (const metric of progressMetricConfigs) {
    const markup = renderToStaticMarkup(
      createElement(ProgressLineChart, { history: metrics, metric }),
    );
    assert.ok(markup.includes(`data-metric="${metric.key}"`));
    assert.ok(markup.includes(`Динамика: ${metric.accessibleLabel}`));
    assert.ok(markup.includes('Неделя 1:'));
    assert.ok(markup.includes('Неделя 2:'));
    assert.equal((markup.match(/data-testid="progress-chart-point"/gu) ?? []).length, 2);
    assert.ok(markup.includes('Нед 1'));
    assert.ok(markup.includes('Нед 2'));
  }
});

test('goal and weekly dialogs expose native controls with canonical bounds', () => {
  const goalMarkup = renderToStaticMarkup(
    createElement(GoalDialog, {
      currentGoal: 'general_health',
      busy: false,
      error: null,
      onClose: () => undefined,
      onSave: () => undefined,
    }),
  );
  assert.equal((goalMarkup.match(/type="radio"/gu) ?? []).length, 4);
  for (const { label } of goalOptions) {
    assert.ok(goalMarkup.includes(label));
  }

  const metricsMarkup = renderToStaticMarkup(
    createElement(WeeklyMetricsDialog, {
      currentWeek: 3,
      busy: false,
      error: null,
      onClose: () => undefined,
      onSave: () => undefined,
    }),
  );
  assert.equal((metricsMarkup.match(/type="range"/gu) ?? []).length, 4);
  assert.equal((metricsMarkup.match(/min="1" max="10" step="1"/gu) ?? []).length, 4);
  assert.match(metricsMarkup, /maxlength="500"/iu);
  assert.ok(metricsMarkup.includes('Неделя 3'));
});

test('progress model helpers clamp, normalize, format and patch immutably', () => {
  assert.equal(clampMetricScore(-2), 1);
  assert.equal(clampMetricScore(7), 7);
  assert.equal(clampMetricScore(18), 10);
  assert.equal(normalizedNote('   '), undefined);
  assert.equal(normalizedNote('  Отличная неделя  '), 'Отличная неделя');
  assert.equal(formatTrainingMinutes(0), '0мин');
  assert.equal(formatTrainingMinutes(60), '1ч');
  assert.equal(formatTrainingMinutes(450), '7ч 30мин');
  assert.equal(formatStreakDays(1), '1 день');
  assert.equal(formatStreakDays(2), '2 дня');
  assert.equal(formatStreakDays(11), '11 дней');
  assert.equal(formatAchievementDate('2026-08-10T23:30:00.000Z', 'Europe/Moscow'), '11.08.2026');

  const updatedGoal = {
    current_goal: 'strength' as const,
    goal_label: progressGoalLabels.strength,
    set_at: '2026-08-21T10:00:00.000Z',
  };
  const withGoal = withUpdatedGoal(response, updatedGoal);
  assert.notEqual(withGoal, response);
  assert.equal(withGoal.goal, updatedGoal);
  assert.equal(withGoal.metrics, response.metrics);
  assert.equal(withGoal.params.survey_updated_at, updatedGoal.set_at);

  const updatedMetrics = { ...response.metrics, pending_survey: false };
  const withMetrics = withUpdatedMetrics(response, updatedMetrics);
  assert.notEqual(withMetrics, response);
  assert.equal(withMetrics.metrics, updatedMetrics);
  assert.equal(withMetrics.goal, response.goal);
});
