import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ProgramDay,
  ProgramDirection,
  ProgramWeekStatus,
  WeekResponse,
} from '@kinetra/shared';

import { TabBar } from '../src/features/navigation/TabBar.js';
import { ProgramWeekView } from '../src/features/program/ProgramWeekView.js';
import { WorkoutPlayer } from '../src/features/program/WorkoutPlayer.js';
import {
  WORKOUT_COMPLETION_THRESHOLD,
  WORKOUT_PROGRESS_CHECK_INTERVAL_MS,
  dayOfWeekInTimeZone,
  directionPresentation,
  optimisticallyCompleteWorkout,
} from '../src/features/program/model.js';
import { appRoutes } from '../src/routing.js';

const directions: readonly ProgramDirection[] = [
  'breathing',
  'strength',
  'body_therapy',
  'functional',
  'stretching',
  'neuro',
  'recovery',
];
const durations = [25, 35, 30, 35, 30, 15, 20] as const;

const programDays = (completedCount = 0): readonly ProgramDay[] =>
  directions.map((direction, index) => ({
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    day_of_week: index + 1,
    direction,
    title: index === 2 ? 'Телесная терапия' : `Seed title ${index + 1}`,
    description: `Описание тренировки ${index + 1}`,
    duration_minutes: durations[index] ?? 20,
    icon: ['wind', 'dumbbell', 'heart-pulse', 'activity', 'move', 'brain', 'moon'][index] as string,
    video: {
      id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      video_url: null,
      poster_url: null,
    },
    completed: index < completedCount,
    completed_at: index < completedCount ? '2026-08-20T12:00:00.000Z' : null,
  }));

const weekResponse = (
  weekNumber = 1,
  status: ProgramWeekStatus = 'active',
  completedCount = 0,
): WeekResponse => ({
  week: {
    id: `10000000-0000-4000-8000-${String(weekNumber).padStart(12, '0')}`,
    week_number: weekNumber,
    title: `Неделя ${weekNumber}`,
    status,
    days: programDays(completedCount),
    days_completed: completedCount,
    total_days: 7,
  },
  total_weeks: 12,
  overall_progress: {
    weeks_completed: Math.max(0, weekNumber - 1),
    total_workouts_done: completedCount,
  },
});

const renderWeek = (
  response: WeekResponse,
  currentWeekNumber: number,
  todayDayOfWeek = 3,
): string =>
  renderToStaticMarkup(
    createElement(ProgramWeekView, {
      response,
      currentWeekNumber,
      todayDayOfWeek,
      isNavigating: false,
      navigationError: null,
      onPreviousWeek: () => undefined,
      onNextWeek: () => undefined,
      onSelectWorkout: () => undefined,
    }),
  );

const buttonTag = (markup: string, testId: string): string => {
  const match = markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`, 'u'));
  assert.notEqual(match, null, `Button ${testId} was not rendered.`);
  return match?.[0] ?? '';
};

test('main screen renders seven canonical workout cards with exact icons and durations', () => {
  const markup = renderWeek(weekResponse(), 1);
  const cards = markup.match(/data-testid="workout-card-\d+"/gu) ?? [];

  assert.equal(cards.length, 7);
  directions.forEach((direction, index) => {
    const presentation = directionPresentation[direction];
    assert.ok(markup.includes(presentation.label));
    assert.ok(markup.includes(presentation.icon));
    assert.ok(markup.includes(`${durations[index]} мин`));
  });
  assert.equal(markup.includes('Телесная терапия'), false);
  assert.equal(markup.includes('heart-pulse'), false);
});

test('week progress exposes X/7 copy and accessible progressbar values', () => {
  const markup = renderWeek(weekResponse(1, 'active', 3), 1);

  assert.ok(markup.includes('3/7'));
  assert.match(
    markup,
    /data-testid="week-progress"[^>]*aria-valuenow="3"[^>]*aria-valuetext="Пройдено 3 из 7"/u,
  );
  assert.ok(markup.includes('style="width:42.857142857142854%"'));
});

test('week arrows stop at week one and at the current-plus-one preview boundary', () => {
  const firstWeek = renderWeek(weekResponse(1, 'active'), 1);
  assert.ok(buttonTag(firstWeek, 'week-previous').includes('disabled'));
  assert.equal(buttonTag(firstWeek, 'week-next').includes('disabled'), false);

  const preview = renderWeek(weekResponse(2, 'locked'), 1);
  assert.equal(buttonTag(preview, 'week-previous').includes('disabled'), false);
  assert.ok(buttonTag(preview, 'week-next').includes('disabled'));
  assert.equal((preview.match(/data-state="locked"/gu) ?? []).length, 7);
  assert.ok(buttonTag(preview, 'workout-card-1').includes('disabled'));

  const finalWeek = renderWeek(weekResponse(12, 'active'), 12);
  assert.ok(buttonTag(finalWeek, 'week-next').includes('disabled'));
});

test('today is highlighted only in the actual current week', () => {
  const current = renderWeek(weekResponse(1, 'active', 1), 1, 3);

  assert.match(
    current,
    /data-testid="workout-card-3"[^>]*data-today="true"|data-today="true"[^>]*data-testid="workout-card-3"/u,
  );
  assert.ok(current.includes('data-testid="today-workout"'));
  assert.match(current, /data-testid="workout-status-1"[^>]*data-state="completed"/u);
  assert.match(current, /data-testid="workout-status-2"[^>]*data-state="available"/u);

  const futurePreview = renderWeek(weekResponse(2, 'locked'), 1, 3);
  assert.equal(futurePreview.includes('data-today="true"'), false);
  assert.equal(futurePreview.includes('data-testid="today-workout"'), false);
});

test('tab bar renders four routes and highlights only the active tab', () => {
  const markup = renderToStaticMarkup(
    createElement(TabBar, {
      route: appRoutes.progress,
      onNavigate: () => undefined,
    }),
  );

  assert.equal(
    (markup.match(/data-testid="tab-(?:home|schedule|progress|settings)"/gu) ?? []).length,
    4,
  );
  assert.equal((markup.match(/aria-current="page"/gu) ?? []).length, 1);
  assert.match(markup, /data-testid="tab-progress"[^>]*aria-current="page"/u);
  assert.ok(markup.includes('Главная'));
  assert.ok(markup.includes('Расписание'));
  assert.ok(markup.includes('Прогресс'));
  assert.ok(markup.includes('Настройки'));

  const savingMarkup = renderToStaticMarkup(
    createElement(TabBar, {
      route: appRoutes.home,
      disabled: true,
      onNavigate: () => undefined,
    }),
  );
  assert.match(savingMarkup, /data-testid="tab-bar"[^>]*aria-busy="true"/u);
  assert.equal((savingMarkup.match(/aria-disabled="true"/gu) ?? []).length, 4);
  assert.equal((savingMarkup.match(/tabindex="-1"/gu) ?? []).length, 4);
});

test('workout player renders the prescribed placeholder for a null video URL', () => {
  const day = programDays()[2] as ProgramDay;
  const markup = renderToStaticMarkup(
    createElement(WorkoutPlayer, {
      day,
      programWeek: 1,
      onCompleted: () => undefined,
      onCompletionBusyChange: () => undefined,
      onClosed: () => undefined,
      onSessionExpired: () => undefined,
    }),
  );

  assert.ok(markup.includes('data-testid="workout-player"'));
  assert.ok(markup.includes('data-testid="workout-video-placeholder"'));
  assert.ok(markup.includes('Видео скоро будет доступно'));
  assert.equal(markup.includes('<video'), false);
});

test('timezone weekday and optimistic boundary completion are deterministic', () => {
  const boundaryDate = new Date('2026-01-04T23:30:00.000Z');
  assert.equal(dayOfWeekInTimeZone(boundaryDate, 'Europe/Moscow'), 1);
  assert.equal(dayOfWeekInTimeZone(boundaryDate, 'America/Los_Angeles'), 7);

  const initial = weekResponse(1, 'active', 6);
  const finalVideoId = initial.week.days[6]?.video.id ?? '';
  const completed = optimisticallyCompleteWorkout(
    initial,
    finalVideoId,
    '2026-08-20T13:00:00.000Z',
  );

  assert.equal(completed.week.days_completed, 7);
  assert.equal(completed.week.status, 'completed');
  assert.equal(completed.week.days[6]?.completed, true);
  assert.equal(completed.overall_progress.total_workouts_done, 7);
  assert.equal(WORKOUT_COMPLETION_THRESHOLD, 90);
  assert.equal(WORKOUT_PROGRESS_CHECK_INTERVAL_MS, 10_000);
});
