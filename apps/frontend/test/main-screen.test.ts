import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ProgramDay,
  ProgramDirection,
  ProgramWeekStatus,
  WeekResponse,
} from '@kinetra/shared';

import { BaseLessonsRequiredDialog } from '../src/features/base-lessons/BaseLessonsRequiredDialog.js';
import { TabBar } from '../src/features/navigation/TabBar.js';
import { ProgramWeekView } from '../src/features/program/ProgramWeekView.js';
import { WorkoutPlayer } from '../src/features/program/WorkoutPlayer.js';
import {
  WORKOUT_COMPLETION_THRESHOLD,
  WORKOUT_PROGRESS_CHECK_INTERVAL_MS,
  dayOfWeekInTimeZone,
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
  trainingLocked = false,
): string =>
  renderToStaticMarkup(
    createElement(ProgramWeekView, {
      response,
      currentWeekNumber,
      todayDayOfWeek,
      isNavigating: false,
      navigationError: null,
      trainingLocked,
      completedBaseLessons: trainingLocked ? 1 : null,
      baseLessonUnlockThreshold: trainingLocked ? 4 : null,
      onOpenBaseLessons: () => undefined,
      onOpenSchedule: () => undefined,
      onSelectWorkout: () => undefined,
    }),
  );

const buttonTag = (markup: string, testId: string): string => {
  const match = markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`, 'u'));
  assert.notEqual(match, null, `Button ${testId} was not rendered.`);
  return match?.[0] ?? '';
};

test('Today dashboard renders only the current and next workout', () => {
  const markup = renderWeek(weekResponse(), 1);
  const cards = markup.match(/data-testid="workout-card-\d+"/gu) ?? [];

  assert.equal(cards.length, 2);
  assert.ok(markup.includes('data-testid="today-heading"'));
  assert.ok(markup.includes('Сегодня'));
  assert.ok(markup.includes('data-testid="workout-card-3"'));
  assert.ok(markup.includes('Телесная терапия'));
  assert.ok(markup.includes('30 мин'));
  assert.ok(markup.includes('data-testid="next-workout"'));
  assert.ok(markup.includes('data-testid="workout-card-4"'));
  assert.ok(markup.includes('Seed title 4'));
  assert.ok(markup.includes('35 мин'));
  assert.equal(markup.includes('data-testid="workout-card-1"'), false);
  assert.equal(markup.includes('data-testid="workout-card-7"'), false);
});

test('week progress exposes completed count and accessible progressbar values', () => {
  const markup = renderWeek(weekResponse(1, 'active', 3), 1);

  assert.ok(markup.includes('3 из 7'));
  assert.match(
    markup,
    /data-testid="week-progress"[^>]*aria-valuenow="3"[^>]*aria-valuetext="Пройдено 3 из 7"/u,
  );
  assert.ok(markup.includes('style="width:42.857142857142854%"'));
});

test('Today dashboard delegates full week browsing to Schedule', () => {
  const markup = renderWeek(weekResponse(1, 'active'), 1);

  assert.equal(markup.includes('data-testid="week-previous"'), false);
  assert.equal(markup.includes('data-testid="week-next"'), false);
  assert.ok(markup.includes('data-testid="today-open-schedule"'));
  assert.ok(markup.includes('Открыть полное расписание'));
});

test('today is highlighted only in the actual current week', () => {
  const current = renderWeek(weekResponse(1, 'active', 3), 1, 3);

  assert.match(
    current,
    /data-testid="workout-card-3"[^>]*data-today="true"|data-today="true"[^>]*data-testid="workout-card-3"/u,
  );
  assert.ok(current.includes('data-testid="today-workout"'));
  assert.match(current, /data-testid="workout-status-3"[^>]*data-state="completed"/u);
  assert.match(current, /data-testid="workout-status-4"[^>]*data-state="available"/u);

  const futurePreview = renderWeek(weekResponse(2, 'locked'), 1, 3);
  assert.equal(futurePreview.includes('data-today="true"'), false);
  assert.equal(futurePreview.includes('data-testid="today-workout"'), false);
  assert.ok(futurePreview.includes('data-testid="today-rest-day"'));
});

test('training preparation keeps the program explorable without opening current workouts', () => {
  const markup = renderWeek(weekResponse(), 1, 3, true);

  assert.ok(markup.includes('data-testid="training-preparation-card"'));
  assert.ok(markup.includes('Пройдено 1 из 4 необходимых'));
  assert.ok(markup.includes('data-testid="preparation-open-base-lessons"'));
  assert.equal((markup.match(/data-training-access="base-lessons-required"/gu) ?? []).length, 2);
  assert.equal((markup.match(/data-state="preparation-required"/gu) ?? []).length, 2);
  assert.equal(buttonTag(markup, 'workout-card-3').includes('disabled'), false);

  const future = renderWeek(weekResponse(2, 'locked'), 1, 3, true);
  assert.equal(future.includes('data-training-access="base-lessons-required"'), false);
  assert.equal(future.includes('data-testid="workout-card-'), false);
});

test('base-lessons gate offers preparation and a return to app exploration', () => {
  const markup = renderToStaticMarkup(
    createElement(BaseLessonsRequiredDialog, {
      open: true,
      completedLessons: 1,
      unlockThreshold: 4,
      onClose: () => undefined,
      onOpenBaseLessons: () => undefined,
    }),
  );

  assert.ok(markup.includes('data-testid="base-lessons-required-dialog"'));
  assert.ok(markup.includes('Сначала подготовимся к тренировке'));
  assert.ok(markup.includes('data-testid="open-base-lessons"'));
  assert.ok(markup.includes('Пройти базовые уроки'));
  assert.ok(markup.includes('data-testid="continue-exploring-app"'));
  assert.ok(markup.includes('Вернуться к изучению приложения'));
});

test('tab bar renders Today and a fifth active Chat tab with its unread badge', () => {
  const markup = renderToStaticMarkup(
    createElement(TabBar, {
      route: appRoutes.chat,
      showChat: true,
      chatUnreadCount: 125,
      onNavigate: () => undefined,
    }),
  );

  assert.equal(
    (markup.match(/data-testid="tab-(?:home|schedule|progress|chat|settings)"/gu) ?? []).length,
    5,
  );
  assert.equal((markup.match(/aria-current="page"/gu) ?? []).length, 1);
  assert.match(markup, /data-testid="tab-chat"[^>]*aria-current="page"/u);
  assert.match(
    markup,
    /data-testid="tab-chat"[^>]*aria-label="Чат с тренером, 99\+ непрочитанных сообщений"/u,
  );
  assert.ok(markup.includes('data-testid="tab-chat-badge"'));
  assert.ok(markup.includes('99+'));
  assert.ok(markup.includes('Сегодня'));
  assert.ok(markup.includes('Расписание'));
  assert.ok(markup.includes('Прогресс'));
  assert.ok(markup.includes('Чат'));
  assert.ok(markup.includes('Настройки'));

  const savingMarkup = renderToStaticMarkup(
    createElement(TabBar, {
      route: appRoutes.home,
      disabled: true,
      showChat: false,
      chatUnreadCount: 0,
      onNavigate: () => undefined,
    }),
  );
  assert.match(savingMarkup, /data-testid="tab-bar"[^>]*aria-busy="true"/u);
  assert.equal(savingMarkup.includes('data-testid="tab-chat"'), false);
  assert.equal((savingMarkup.match(/aria-disabled="true"/gu) ?? []).length, 4);
  assert.equal((savingMarkup.match(/tabindex="-1"/gu) ?? []).length, 4);
});

test('system Back keeps the saving workout on its canonical history entry', async () => {
  const [appSource, programScreenSource] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/program/ProgramScreen.tsx', import.meta.url), 'utf8'),
  ]);

  const appPopStateStart = appSource.indexOf('const handlePopState = (): void => {');
  const appPopStateEnd = appSource.indexOf(
    "window.addEventListener('popstate', handlePopState)",
    appPopStateStart,
  );
  assert.notEqual(appPopStateStart, -1);
  assert.notEqual(appPopStateEnd, -1);
  const appPopStateHandler = appSource.slice(appPopStateStart, appPopStateEnd);
  const appHistoryFence = appPopStateHandler.indexOf('if (historyFenceRef.current)');
  const appRouteWrite = appPopStateHandler.indexOf(
    'setRoute(normalizeAppRoute(window.location.pathname))',
  );
  assert.notEqual(appHistoryFence, -1);
  assert.notEqual(appRouteWrite, -1);
  assert.ok(appHistoryFence < appRouteWrite);
  assert.ok(appPopStateHandler.slice(appHistoryFence, appRouteWrite).includes('return;'));

  const busyCallbackStart = appSource.indexOf(
    'const handleWorkoutCompletionBusyChange = useCallback(',
  );
  const busyCallbackEnd = appSource.indexOf(
    'const navigateActiveTab = useCallback(',
    busyCallbackStart,
  );
  assert.notEqual(busyCallbackStart, -1);
  assert.notEqual(busyCallbackEnd, -1);
  const busyCallback = appSource.slice(busyCallbackStart, busyCallbackEnd);
  const busyRefWrite = busyCallback.indexOf('workoutCompletionBusyRef.current = busy');
  const busyStateWrite = busyCallback.indexOf('setWorkoutCompletionBusy(busy)');
  assert.notEqual(busyRefWrite, -1);
  assert.notEqual(busyStateWrite, -1);
  assert.ok(busyRefWrite < busyStateWrite);
  assert.ok(
    appSource.includes('onWorkoutCompletionBusyChange={handleWorkoutCompletionBusyChange}'),
  );

  const programFenceStart = programScreenSource.indexOf('completionBusyRef.current &&');
  const programFenceEnd = programScreenSource.indexOf('\n\n      if (', programFenceStart);
  assert.notEqual(programFenceStart, -1);
  assert.notEqual(programFenceEnd, -1);
  const programFence = programScreenSource.slice(programFenceStart, programFenceEnd);
  assert.ok(programFence.includes('window.history.pushState('));
  assert.ok(programFence.includes('kinetraWorkoutVideoId: selectedVideoIdRef.current'));
  assert.ok(programFence.includes('kinetraProgramWeek: selectedProgramWeekRef.current'));
  assert.ok(programFence.includes('appRoutes.home'));
  assert.equal(programFence.includes('window.location.href'), false);
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
