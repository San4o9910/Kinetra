import type {
  GoalResponse,
  MetricsResponse,
  ProgressResponse,
  SurveyGoal,
  WeeklyMetric,
} from '@kinetra/shared';

export type ProgressMetricKey = 'energy' | 'sleep' | 'mood' | 'body_satisfaction';

export interface ProgressMetricConfig {
  readonly key: ProgressMetricKey;
  readonly label: string;
  readonly accessibleLabel: string;
  readonly testId: string;
}

export const progressMetricConfigs = [
  { key: 'energy', label: 'Энергия', accessibleLabel: 'Уровень энергии', testId: 'energy' },
  { key: 'sleep', label: 'Сон', accessibleLabel: 'Качество сна', testId: 'sleep' },
  { key: 'mood', label: 'Настроение', accessibleLabel: 'Настроение', testId: 'mood' },
  {
    key: 'body_satisfaction',
    label: 'Тело',
    accessibleLabel: 'Удовлетворённость телом',
    testId: 'body-satisfaction',
  },
] as const satisfies readonly ProgressMetricConfig[];

export const progressGoalLabels = Object.freeze({
  flexibility: 'Хочу быть гибким и подвижным',
  strength: 'Хочу стать сильнее и выносливее',
  awareness: 'Хочу лучше чувствовать своё тело',
  general_health: 'Хочу поддерживать форму и здоровье',
} satisfies Readonly<Record<SurveyGoal, string>>);

export const goalOptions = (
  Object.entries(progressGoalLabels) as readonly [SurveyGoal, string][]
).map(([value, label]) => ({ value, label }));

export const metricValue = (metric: WeeklyMetric, key: ProgressMetricKey): number => metric[key];

export const clampMetricScore = (value: number): number => Math.min(10, Math.max(1, value));

export const normalizedNote = (value: string): string | undefined => {
  const note = value.trim();
  return note.length === 0 ? undefined : note;
};

export const formatTrainingMinutes = (minutes: number): string => {
  const wholeMinutes = Math.max(0, Math.trunc(minutes));
  const hours = Math.floor(wholeMinutes / 60);
  const remainder = wholeMinutes % 60;

  if (hours === 0) {
    return `${remainder}мин`;
  }

  return remainder === 0 ? `${hours}ч` : `${hours}ч ${remainder}мин`;
};

export const formatStreakDays = (days: number): string => {
  const absolute = Math.abs(days) % 100;
  const last = absolute % 10;
  const suffix =
    absolute >= 11 && absolute <= 14 ? 'дней' : last === 1 ? 'день' : last < 5 ? 'дня' : 'дней';
  return `${days} ${suffix}`;
};

export const formatAchievementDate = (timestamp: string, timezone: string): string => {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: timezone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  }
};

export const withUpdatedGoal = (
  response: ProgressResponse,
  goal: GoalResponse,
): ProgressResponse => ({
  ...response,
  goal,
  params: { ...response.params, survey_updated_at: goal.set_at },
});

export const withUpdatedMetrics = (
  response: ProgressResponse,
  metrics: MetricsResponse,
): ProgressResponse => ({ ...response, metrics });
