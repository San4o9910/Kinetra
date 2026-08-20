import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BaseLesson, BaseLessonsResponse, LessonProgressResponse } from '@kinetra/shared';

import { BaseLessonsView } from '../src/features/base-lessons/BaseLessonsView.js';
import { LessonPlayer } from '../src/features/base-lessons/LessonPlayer.js';
import {
  LessonProgressReporter,
  LatestRequestGuard,
  PROGRESS_SYNC_INTERVAL_MS,
  baseProgramActionLabel,
  completionStateForProgress,
  createProgressSnapshot,
  formatLessonDuration,
  mergeSavedLessonProgress,
} from '../src/features/base-lessons/model.js';

const titles = [
  'Как понять правильно ли я дышу?',
  'Как правильно отжиматься?',
  'Как научиться подтягиваться?',
  'Как приседать?',
  'Как и зачем делать становую тягу?',
  'Я не хочу заниматься каждый день!',
  'Что я ем?',
] as const;

const lessons: readonly BaseLesson[] = titles.map((title, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  slug: `base-lesson-${index + 1}`,
  title,
  description: `Описание урока ${index + 1}`,
  duration_seconds: 600,
  order_index: index + 1,
  poster_url: null,
  video_url: null,
  progress: { completion_percent: 0, completed: false },
}));

const responseWithCompleted = (totalCompleted: number): BaseLessonsResponse => ({
  lessons: lessons.map((lesson, index) =>
    index < totalCompleted
      ? { ...lesson, progress: { completion_percent: 100, completed: true } }
      : lesson,
  ),
  total_completed: totalCompleted,
  unlock_threshold: 4,
  program_unlocked: totalCompleted >= 4,
});

const renderList = (response: BaseLessonsResponse): string =>
  renderToStaticMarkup(
    createElement(BaseLessonsView, {
      response,
      isCompleting: false,
      errorMessage: null,
      onSelectLesson: () => undefined,
      onComplete: () => undefined,
      onOpenSettings: () => undefined,
    }),
  );

const completeButtonTag = (markup: string): string => {
  const tag = markup.match(/<button[^>]*data-testid="base-lessons-complete"[^>]*>/u)?.[0];
  assert.notEqual(tag, undefined, 'Complete-program button was not rendered.');
  return tag ?? '';
};

const progressResponse = (completionPercent: number): LessonProgressResponse => ({
  position_seconds: completionPercent,
  completion_percent: completionPercent,
  completed: completionPercent >= 90,
  completed_at: completionPercent >= 90 ? '2026-08-20T00:00:00.000Z' : null,
});

test('base-lessons view renders all seven exact lesson cards in order', () => {
  const markup = renderList(responseWithCompleted(0));
  const renderedCards = markup.match(/data-testid="base-lesson-card-\d+"/gu) ?? [];

  assert.equal(renderedCards.length, 7);
  titles.forEach((title) => assert.ok(markup.includes(title), `Missing lesson title: ${title}`));
  assert.ok(markup.includes('Пройдено 0 из 7'));
});

test('base-lessons view renders completed, in-progress and not-started visual card states', () => {
  const mixedResponse: BaseLessonsResponse = {
    ...responseWithCompleted(0),
    lessons: lessons.map((lesson, index) => {
      if (index === 0) {
        return { ...lesson, progress: { completion_percent: 100, completed: true } };
      }

      if (index === 1) {
        return { ...lesson, progress: { completion_percent: 45, completed: false } };
      }

      return lesson;
    }),
    total_completed: 1,
  };
  const markup = renderList(mixedResponse);

  assert.match(
    markup,
    /data-testid="base-lesson-status-1"[^>]*data-state="completed"[^>]*class="base-lesson-status is-completed"|class="base-lesson-status is-completed"[^>]*data-testid="base-lesson-status-1"[^>]*data-state="completed"/u,
  );
  assert.ok(markup.includes('<span>Пройден</span>'));
  assert.match(
    markup,
    /data-testid="base-lesson-status-2"[^>]*data-state="in-progress"|data-state="in-progress"[^>]*data-testid="base-lesson-status-2"/u,
  );
  assert.ok(markup.includes('class="base-lesson-card-progress"'));
  assert.ok(markup.includes('style="width:45%"'));
  assert.match(
    markup,
    /data-testid="base-lesson-status-3"[^>]*data-state="not-started"|data-state="not-started"[^>]*data-testid="base-lesson-status-3"/u,
  );
  assert.ok(markup.includes('class="base-lesson-empty-circle"'));
});

test('complete-program button is disabled below four lessons and its label is dynamic', () => {
  const emptyMarkup = renderList(responseWithCompleted(0));
  assert.ok(completeButtonTag(emptyMarkup).includes('disabled'));
  assert.ok(emptyMarkup.includes('Пройдите ещё 4 уроков'));

  const partialMarkup = renderList(responseWithCompleted(3));
  assert.ok(completeButtonTag(partialMarkup).includes('disabled'));
  assert.ok(partialMarkup.includes('Пройдите ещё 1 уроков'));
  assert.equal(baseProgramActionLabel(2, 4), 'Пройдите ещё 2 уроков');
});

test('complete-program button becomes active after four completed lessons', () => {
  const markup = renderList(responseWithCompleted(4));

  assert.equal(completeButtonTag(markup).includes('disabled'), false);
  assert.ok(markup.includes('Перейти к программе'));
});

test('lesson player renders the exact placeholder when video URL is absent', () => {
  const markup = renderToStaticMarkup(
    createElement(LessonPlayer, {
      lesson: lessons[6] as BaseLesson,
      onClosed: () => undefined,
      onSessionExpired: () => undefined,
    }),
  );

  assert.ok(markup.includes('data-testid="base-lesson-player"'));
  assert.ok(markup.includes('data-testid="base-lesson-video-placeholder"'));
  assert.ok(markup.includes('Видео скоро будет доступно'));
  assert.equal(markup.includes('<video'), false);
});

test('saved lesson progress updates the list optimistically before a background refetch', () => {
  const initial = responseWithCompleted(0);
  const updated = mergeSavedLessonProgress(initial, lessons[0]?.id ?? '', {
    position_seconds: 540,
    completion_percent: 90,
    completed: true,
    completed_at: '2026-08-20T00:00:00.000Z',
  });

  assert.equal(updated.lessons[0]?.progress.completion_percent, 90);
  assert.equal(updated.lessons[0]?.progress.completed, true);
  assert.equal(updated.total_completed, 1);
  assert.equal(updated.program_unlocked, false);
  assert.equal(mergeSavedLessonProgress(initial, 'unknown', null), initial);
});

test('only the latest background lesson refresh may replace optimistic progress', () => {
  const guard = new LatestRequestGuard();
  const firstRefresh = guard.begin();
  const secondRefresh = guard.begin();

  assert.equal(guard.isLatest(firstRefresh), false);
  assert.equal(guard.isLatest(secondRefresh), true);
});

test('lesson formatting and completion states follow the T06 thresholds', () => {
  assert.equal(formatLessonDuration(600), '10 мин');
  assert.equal(PROGRESS_SYNC_INTERVAL_MS, 10_000);
  assert.equal(
    completionStateForProgress({ completion_percent: 0, completed: false }),
    'not_started',
  );
  assert.equal(
    completionStateForProgress({ completion_percent: 45, completed: false }),
    'in_progress',
  );
  assert.equal(
    completionStateForProgress({ completion_percent: 90, completed: false }),
    'completed',
  );
  assert.deepEqual(createProgressSnapshot(95, 100, 20), {
    position_seconds: 95,
    completion_percent: 95,
  });
  assert.deepEqual(createProgressSnapshot(30, 100, 95), {
    position_seconds: 30,
    completion_percent: 95,
  });
  assert.deepEqual(createProgressSnapshot(30, 100, 95, true), {
    position_seconds: 30,
    completion_percent: 100,
  });
});

test('progress reporter serializes writes, coalesces pending updates and keeps high-water completion', async () => {
  const sent: Array<{ readonly position_seconds: number; readonly completion_percent: number }> =
    [];
  let releaseFirst: ((response: LessonProgressResponse) => void) | null = null;

  const reporter = new LessonProgressReporter(0, async (progress) => {
    sent.push(progress);

    if (sent.length === 1) {
      return new Promise<LessonProgressResponse>((resolve) => {
        releaseFirst = resolve;
      });
    }

    return progressResponse(progress.completion_percent);
  });

  const first = reporter.enqueue(reporter.snapshot(10, 100));
  const second = reporter.enqueue(reporter.snapshot(20, 100));
  const final = reporter.flush(reporter.snapshot(15, 100));

  assert.deepEqual(sent, [{ position_seconds: 10, completion_percent: 10 }]);
  releaseFirst?.(progressResponse(10));
  await Promise.all([first, second, final]);

  assert.deepEqual(sent, [
    { position_seconds: 10, completion_percent: 10 },
    { position_seconds: 15, completion_percent: 20 },
  ]);
  assert.deepEqual(reporter.snapshot(5, 100), {
    position_seconds: 5,
    completion_percent: 20,
  });
});

test('progress reporter flush waits until a late periodic write is fully drained', async () => {
  const sent: Array<{ readonly position_seconds: number; readonly completion_percent: number }> =
    [];
  const releases: Array<() => void> = [];
  const reporter = new LessonProgressReporter(0, (progress) => {
    sent.push(progress);

    return new Promise<LessonProgressResponse>((resolve) => {
      releases.push(() => resolve(progressResponse(progress.completion_percent)));
    });
  });
  const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const periodic = reporter.enqueue(reporter.snapshot(10, 100));
  const final = reporter.flush(reporter.snapshot(95, 100));
  assert.deepEqual(sent, [{ position_seconds: 10, completion_percent: 10 }]);

  releases.shift()?.();
  await periodic;
  await nextTurn();
  assert.deepEqual(sent[1], { position_seconds: 95, completion_percent: 95 });

  const latePeriodic = reporter.enqueue(reporter.snapshot(96, 100));
  let flushSettled = false;
  void final.then(() => {
    flushSettled = true;
  });

  releases.shift()?.();
  await nextTurn();
  assert.deepEqual(sent[2], { position_seconds: 96, completion_percent: 96 });
  assert.equal(flushSettled, false);

  releases.shift()?.();
  await Promise.all([final, latePeriodic]);
  assert.equal(flushSettled, true);
});
