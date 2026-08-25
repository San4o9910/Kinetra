import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  TrainerVideoProgramResponse,
  TrainerVideoSlotDto,
  TrainerVideoSlotState,
  TrainerVideoUploadDto,
} from '@kinetra/shared';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TrainerAdminShell } from '../src/features/trainer-shell/TrainerAdminShell.js';
import {
  createTrainerVideoProgramPollingController,
  TRAINER_VIDEO_PROGRAM_POLL_MAX_DURATION_MS,
  type TrainerVideoProgramPollingDependencies,
} from '../src/features/trainer-videos/program-polling.js';
import {
  validateTrainerVideoProgram,
  videoStatusText,
} from '../src/features/trainer-videos/model.js';
import { appRoutes } from '../src/routing.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const slot = (
  weekNumber: number,
  dayOfWeek: number,
  state: TrainerVideoSlotState = 'empty',
): TrainerVideoSlotDto => ({
  video_id: `00000000-0000-4000-8${String(weekNumber).padStart(3, '0')}-${String(dayOfWeek).padStart(12, '0')}`,
  day_of_week: dayOfWeek,
  day_label: `День ${dayOfWeek}`,
  direction: 'breathing',
  title: `Тренировка ${weekNumber}.${dayOfWeek}`,
  duration_minutes: 25,
  media: {
    available: state === 'available' || state === 'replacing',
    revision: 0,
    duration_seconds: null,
    uploaded_at: null,
  },
  slot_state: state,
  live_upload: null,
  latest_upload: null,
});

const program = (): TrainerVideoProgramResponse => ({
  summary: { total: 84, available: 0, processing: 0, failed: 0 },
  weeks: Array.from({ length: 12 }, (_, weekIndex) => ({
    week_number: weekIndex + 1,
    title: `Неделя ${weekIndex + 1}`,
    days: Array.from({ length: 7 }, (_, dayIndex) => slot(weekIndex + 1, dayIndex + 1)),
  })),
});

const liveUpload = (status: TrainerVideoUploadDto['status']): TrainerVideoUploadDto => ({
  id: '00000000-0000-4000-8000-000000000091',
  video_id: '00000000-0000-4000-8001-000000000001',
  week_number: 1,
  day_of_week: 1,
  status,
  expected_size_bytes: 10,
  uploaded_bytes: 10,
  part_size_bytes: 5,
  part_count: 2,
  expires_at: '2026-08-25T12:00:00.000Z',
  failure_code: null,
  verified_media: null,
});

const processingProgram = (
  status: 'completing' | 'verification_pending' | 'verifying',
): TrainerVideoProgramResponse => {
  const current = program();
  const firstWeek = current.weeks[0]!;
  const firstSlot = firstWeek.days[0]!;
  return {
    ...current,
    summary: { ...current.summary, processing: 1 },
    weeks: [
      {
        ...firstWeek,
        days: [
          {
            ...firstSlot,
            slot_state: 'processing',
            live_upload: liveUpload(status),
            latest_upload: liveUpload(status),
          },
          ...firstWeek.days.slice(1),
        ],
      },
      ...current.weeks.slice(1),
    ],
  };
};

const deferred = <Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} => {
  let resolvePromise: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
};

const settlePromises = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test('T14 trainer shell exposes capability-driven tabs with the current page', () => {
  const videosMarkup = renderToStaticMarkup(
    createElement(
      TrainerAdminShell,
      {
        route: appRoutes.trainerVideos,
        canManageVideos: true,
        onNavigate: () => undefined,
        onSignOut: () => undefined,
      },
      createElement('p', null, 'Видео тренировок'),
    ),
  );
  assert.match(videosMarkup, /aria-label="Разделы тренера"/u);
  assert.match(videosMarkup, /href="\/trainer\/videos" aria-current="page"/u);
  assert.match(videosMarkup, />Диалоги</u);
  assert.match(videosMarkup, />Видео</u);

  const chatOnlyMarkup = renderToStaticMarkup(
    createElement(
      TrainerAdminShell,
      {
        route: appRoutes.trainerChats,
        canManageVideos: false,
        onNavigate: () => undefined,
        onSignOut: () => undefined,
      },
      createElement('p', null, 'Диалоги'),
    ),
  );
  assert.equal(chatOnlyMarkup.includes('href="/trainer/videos"'), false);
});

test('T14 inventory accepts exactly 12 ordered weeks by 7 ordered unique workout slots', () => {
  const valid = program();
  assert.equal(validateTrainerVideoProgram(valid), valid);

  for (const invalid of [
    { ...valid, weeks: valid.weeks.slice(0, 11) },
    {
      ...valid,
      weeks: valid.weeks.map((week, index) =>
        index === 0 ? { ...week, days: week.days.slice(0, 6) } : week,
      ),
    },
    {
      ...valid,
      weeks: valid.weeks.map((week, index) => (index === 1 ? { ...week, week_number: 12 } : week)),
    },
    {
      ...valid,
      weeks: valid.weeks.map((week, index) =>
        index === 0
          ? {
              ...week,
              days: week.days.map((day) => ({
                ...day,
                video_id: valid.weeks[1]!.days[0]!.video_id,
              })),
            }
          : week,
      ),
    },
  ]) {
    assert.throws(() => validateTrainerVideoProgram(invalid), /неполную программу видео/u);
  }
});

test('T14 slot states have explicit text instead of color-only meaning', () => {
  const expected = new Map<TrainerVideoSlotState, string>([
    ['empty', 'Видео не загружено'],
    ['uploading', 'Загрузка продолжается'],
    ['processing', 'Файл загружен, проверяем'],
    ['available', 'Доступно клиентам'],
    ['replacing', 'Старое видео доступно, новое загружается'],
    ['hidden', 'Скрыто — клиенты видят заглушку'],
  ]);
  for (const [state, text] of expected) {
    assert.equal(videoStatusText(slot(1, 1, state)), text);
  }
  assert.equal(videoStatusText(slot(1, 1, 'failed')), 'Видео не прошло проверку.');
  console.log('KINETRA_T14_TRAINER_UI=PASS');
});

test('T14 mount after reload resumes bounded polling for an upload already verifying', async () => {
  const verifying = processingProgram('verifying');
  const published = program();
  const programs = [verifying, published];
  const observed: TrainerVideoProgramResponse[] = [];
  const statusPolls: string[] = [];
  const timers = new Map<number, () => void>();
  let timerSequence = 0;
  let programCalls = 0;
  const dependencies: TrainerVideoProgramPollingDependencies = {
    getProgram: async () => programs[Math.min(programCalls++, programs.length - 1)]!,
    getUpload: async (uploadId) => {
      statusPolls.push(uploadId);
      return { upload: liveUpload('published') };
    },
    isUploadActive: () => false,
    now: () => 1_000,
    setTimer: (callback) => {
      const id = ++timerSequence;
      timers.set(id, () => {
        timers.delete(id);
        callback();
      });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
  };
  const controller = createTrainerVideoProgramPollingController(
    dependencies,
    {
      onProgram: (next) => observed.push(next),
      onError: (caught) => assert.fail(caught),
      onDeadline: () => assert.fail('Polling unexpectedly reached its deadline.'),
    },
    true,
  );

  controller.start();
  await settlePromises();
  assert.deepEqual(observed, [verifying]);
  assert.equal(timers.size, 1);
  const scheduledPoll = timers.values().next().value;
  assert.notEqual(scheduledPoll, undefined);
  scheduledPoll!();
  await settlePromises();

  assert.deepEqual(statusPolls, [liveUpload('verifying').id]);
  assert.deepEqual(observed, [verifying, published]);
  assert.equal(timers.size, 0);
  controller.dispose();
});

test('T14 mount schedules recovery polling for every durable processing status', async () => {
  for (const status of ['completing', 'verification_pending', 'verifying'] as const) {
    const timers = new Map<number, () => void>();
    const controller = createTrainerVideoProgramPollingController(
      {
        getProgram: async () => processingProgram(status),
        getUpload: async () => assert.fail('The scheduled timer is not run by this test.'),
        isUploadActive: () => false,
        now: () => 1_000,
        setTimer: (callback) => {
          timers.set(1, callback);
          return 1;
        },
        clearTimer: (id) => {
          timers.delete(id);
        },
      },
      {
        onProgram: () => undefined,
        onError: (caught) => assert.fail(caught),
        onDeadline: () => assert.fail('Polling unexpectedly reached its deadline.'),
      },
      true,
    );

    controller.start();
    await settlePromises();
    assert.equal(timers.size, 1, `${status} must schedule a recovery poll`);
    controller.dispose();
    assert.equal(timers.size, 0);
  }
});

test('T14 program polling fences a stale response even when its aborted request resolves late', async () => {
  const stale = deferred<TrainerVideoProgramResponse>();
  const current = deferred<TrainerVideoProgramResponse>();
  const requests = [stale, current];
  const signals: AbortSignal[] = [];
  const observed: TrainerVideoProgramResponse[] = [];
  let requestIndex = 0;
  const controller = createTrainerVideoProgramPollingController(
    {
      getProgram: (signal) => {
        signals.push(signal);
        return requests[requestIndex++]!.promise;
      },
      getUpload: async () => assert.fail('A terminal program must not schedule status polling.'),
      isUploadActive: () => false,
      now: () => 1_000,
      setTimer: () => assert.fail('A terminal program must not schedule a timer.'),
      clearTimer: () => undefined,
    },
    {
      onProgram: (next) => observed.push(next),
      onError: (caught) => assert.fail(caught),
      onDeadline: () => assert.fail('Polling unexpectedly reached its deadline.'),
    },
    true,
  );

  controller.start();
  controller.refresh();
  assert.equal(signals[0]?.aborted, true);
  const accepted = program();
  current.resolve(accepted);
  await settlePromises();
  stale.resolve(processingProgram('verifying'));
  await settlePromises();

  assert.deepEqual(observed, [accepted]);
  controller.dispose();
});

test('T14 background verification polling stops at its bounded deadline', async () => {
  const verifying = processingProgram('verification_pending');
  const timers = new Map<number, () => void>();
  let now = 1_000;
  let timerSequence = 0;
  let deadlines = 0;
  const controller = createTrainerVideoProgramPollingController(
    {
      getProgram: async () => verifying,
      getUpload: async () => ({ upload: liveUpload('verifying') }),
      isUploadActive: () => false,
      now: () => now,
      setTimer: (callback) => {
        const id = ++timerSequence;
        timers.set(id, () => {
          timers.delete(id);
          callback();
        });
        return id;
      },
      clearTimer: (id) => {
        timers.delete(id);
      },
    },
    {
      onProgram: () => undefined,
      onError: (caught) => assert.fail(caught),
      onDeadline: () => {
        deadlines += 1;
      },
    },
    true,
  );

  controller.start();
  await settlePromises();
  const scheduledPoll = timers.values().next().value;
  assert.notEqual(scheduledPoll, undefined);
  now += TRAINER_VIDEO_PROGRAM_POLL_MAX_DURATION_MS;
  scheduledPoll!();
  await settlePromises();

  assert.equal(deadlines, 1);
  assert.equal(timers.size, 0);
  controller.dispose();
});
