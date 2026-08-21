import type { ProgramDay, ProgramDirection, WeekResponse } from '@kinetra/shared';

export const WORKOUT_COMPLETION_THRESHOLD = 90;
export const WORKOUT_PROGRESS_CHECK_INTERVAL_MS = 10_000;

export type WorkoutCardState = 'completed' | 'available' | 'locked';

export interface DirectionPresentation {
  readonly label: string;
  readonly icon: string;
}

export const directionPresentation = Object.freeze({
  breathing: { label: 'Дыхание', icon: '🧘' },
  strength: { label: 'Сила', icon: '💪' },
  body_therapy: { label: 'Тело мой дом', icon: '🌿' },
  functional: { label: 'Функционал', icon: '⚡' },
  stretching: { label: 'Растяжка', icon: '🧘‍♂️' },
  neuro: { label: 'Нейрогимнастика', icon: '🧠' },
  recovery: { label: 'Восстановление', icon: '🍲' },
} satisfies Readonly<Record<ProgramDirection, DirectionPresentation>>);

export const weekdayShortLabels = Object.freeze([
  '',
  'Пн',
  'Вт',
  'Ср',
  'Чт',
  'Пт',
  'Сб',
  'Вс',
] as const);

export const weekdayLongLabels = Object.freeze([
  '',
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
  'Воскресенье',
] as const);

const weekdayTokens = new Map<string, number>([
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
  ['Sun', 7],
]);

const localDayOfWeek = (date: Date): number => date.getDay() || 7;

export const dayOfWeekInTimeZone = (date: Date, timeZone: string): number => {
  try {
    const token = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
    }).format(date);
    return weekdayTokens.get(token) ?? localDayOfWeek(date);
  } catch {
    return localDayOfWeek(date);
  }
};

export const maximumAccessibleWeek = (currentWeekNumber: number, totalWeeks: number): number =>
  Math.min(totalWeeks, currentWeekNumber + 1);

export const isProgramWeekLocked = (response: WeekResponse, currentWeekNumber: number): boolean =>
  response.week.status === 'locked' || response.week.week_number > currentWeekNumber;

export const workoutCardState = (day: ProgramDay, weekLocked: boolean): WorkoutCardState => {
  if (weekLocked) {
    return 'locked';
  }

  return day.completed ? 'completed' : 'available';
};

export const weekProgressPercent = (completed: number, total: number): number => {
  if (total <= 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, (completed / total) * 100));
};

export const optimisticallyCompleteWorkout = (
  response: WeekResponse,
  videoId: string,
  completedAt: string,
): WeekResponse => {
  let changed = false;
  const days = response.week.days.map((day) => {
    if (day.video.id !== videoId || day.completed) {
      return day;
    }

    changed = true;
    return { ...day, completed: true, completed_at: completedAt };
  });

  if (!changed) {
    return response;
  }

  const daysCompleted = days.filter(({ completed }) => completed).length;
  const weekFinished = daysCompleted >= response.week.total_days;

  return {
    ...response,
    week: {
      ...response.week,
      days,
      days_completed: daysCompleted,
      status: weekFinished ? 'completed' : response.week.status,
    },
    overall_progress: {
      weeks_completed: response.overall_progress.weeks_completed + (weekFinished ? 1 : 0),
      total_workouts_done: response.overall_progress.total_workouts_done + 1,
    },
  };
};
