import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ProgramDirection,
  ProgramScheduleDay,
  ProgramScheduleWeek,
  ScheduleResponse,
} from '@kinetra/shared';

import { ScheduleView, type ScheduleSection } from '../src/features/schedule/ScheduleView.js';

const scheduleDays: readonly ProgramScheduleDay[] = [
  {
    day_of_week: 1,
    day_label: 'Понедельник',
    direction: 'breathing',
    icon: '🧘',
    title: 'Дыхательная практика',
    description: 'Настройка нервной системы, учимся дышать животом.',
    duration_minutes: 25,
    completed: true,
  },
  {
    day_of_week: 2,
    day_label: 'Вторник',
    direction: 'strength',
    icon: '💪',
    title: 'Силовая тренировка',
    description: 'Приседания, тяги, жимы. 3 круга.',
    duration_minutes: 35,
    completed: true,
  },
  {
    day_of_week: 3,
    day_label: 'Среда',
    direction: 'body_therapy',
    icon: '🌿',
    title: 'Тело мой дом',
    description: 'Снимаем зажимы, работаем с телом.',
    duration_minutes: 30,
    completed: false,
  },
  {
    day_of_week: 4,
    day_label: 'Четверг',
    direction: 'functional',
    icon: '⚡',
    title: 'Функциональная тренировка',
    description: 'Динамика, координация, баланс.',
    duration_minutes: 35,
    completed: false,
  },
  {
    day_of_week: 5,
    day_label: 'Пятница',
    direction: 'stretching',
    icon: '🧘‍♂️',
    title: 'Растяжка',
    description: 'Восстанавливаем длину мышц.',
    duration_minutes: 30,
    completed: false,
  },
  {
    day_of_week: 6,
    day_label: 'Суббота',
    direction: 'neuro',
    icon: '🧠',
    title: 'Нейрогимнастика',
    description: 'Упражнения для мозга и координации.',
    duration_minutes: 15,
    completed: false,
  },
  {
    day_of_week: 7,
    day_label: 'Воскресенье',
    direction: 'recovery',
    icon: '🍲',
    title: 'Восстановление',
    description: 'Самомассаж и полезное блюдо.',
    duration_minutes: 20,
    completed: false,
  },
];

const week = (weekNumber: number, completed = weekNumber === 1): ProgramScheduleWeek => ({
  week_number: weekNumber,
  title: `Неделя ${weekNumber}`,
  days: scheduleDays.map((day) => ({ ...day, completed: completed && day.completed })),
  days_completed: completed ? 2 : 0,
  total_days: 7,
});

const scheduleResponse = (currentWeek = 1, hasNext = true): ScheduleResponse => ({
  current_week: week(currentWeek, true),
  next_week: hasNext ? week(currentWeek + 1, false) : null,
});

const renderSchedule = (response: ScheduleResponse, activeSection: ScheduleSection): string =>
  renderToStaticMarkup(
    createElement(ScheduleView, {
      response,
      activeSection,
      onSectionChange: () => undefined,
      onOpenDay: () => undefined,
    }),
  );

test('current schedule renders seven canonical days, descriptions and completion state', () => {
  const markup = renderSchedule(scheduleResponse(), 'current');

  assert.equal((markup.match(/data-testid="schedule-current-day-\d+"/gu) ?? []).length, 7);
  assert.equal(markup.includes('data-testid="schedule-next-day-'), false);
  assert.ok(markup.includes('Текущая неделя'));
  assert.ok(markup.includes('Выполнено 2 из 7'));
  assert.match(
    markup,
    /data-testid="schedule-progress"[^>]*aria-valuenow="2"[^>]*aria-valuetext="Выполнено 2 из 7"/u,
  );

  for (const day of scheduleDays) {
    assert.ok(markup.includes(day.day_label));
    assert.ok(markup.includes(day.title));
    assert.ok(markup.includes(day.description ?? ''));
    assert.ok(markup.includes(day.icon));
    assert.ok(markup.includes(`${day.duration_minutes} мин`));
  }

  assert.equal((markup.match(/data-testid="schedule-completed-\d+"/gu) ?? []).length, 2);
  assert.equal((markup.match(/✅/gu) ?? []).length, 2);
});

test('segmented next-week view renders seven days without completion status', () => {
  const markup = renderSchedule(scheduleResponse(), 'next');

  assert.equal((markup.match(/data-testid="schedule-next-day-\d+"/gu) ?? []).length, 7);
  assert.equal(markup.includes('data-testid="schedule-current-day-'), false);
  assert.ok(markup.includes('Следующая неделя'));
  assert.match(
    markup,
    /data-testid="schedule-segment-next"[^>]*aria-selected="true"[^>]*tabindex="0"/u,
  );
  assert.equal(markup.includes('schedule-completed-'), false);
  assert.equal(markup.includes('✅'), false);
  assert.equal((markup.match(/data-completed="false"/gu) ?? []).length, 7);
});

test('final week hides the next segment and displays the terminal program message', () => {
  const markup = renderSchedule(scheduleResponse(12, false), 'next');

  assert.equal(markup.includes('data-testid="schedule-segmented"'), false);
  assert.equal(markup.includes('data-testid="schedule-panel-next"'), false);
  assert.ok(markup.includes('Текущая неделя'));
  assert.ok(markup.includes('Вы на финальной неделе программы!'));
  assert.ok(markup.includes('🎉'));
});

test('schedule directions remain exhaustive and ordered', () => {
  const directions: readonly ProgramDirection[] = scheduleDays.map(({ direction }) => direction);
  assert.deepEqual(directions, [
    'breathing',
    'strength',
    'body_therapy',
    'functional',
    'stretching',
    'neuro',
    'recovery',
  ]);
});
