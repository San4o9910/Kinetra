import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  NotificationSchedulerService,
  type NotificationRunSummary,
} from '../src/push/scheduler-service.js';
import { FakeSubscriptionAccessChecker } from './support/fake-subscription-access-checker.js';
import { InMemoryProgramRepository } from './support/in-memory-program.repository.js';
import { InMemoryProgressRepository } from './support/in-memory-progress.repository.js';
import { InMemoryPushRepository } from './support/in-memory-push.repository.js';
import { FakePushSender } from './support/fake-webpush-sender.js';
import { MutableClock } from './support/test-clock.js';

const seedDevice = async (
  repository: InMemoryPushRepository,
  userId: string,
  endpoint: string,
): Promise<void> => {
  assert.equal(
    await repository.upsertSubscription({
      userId,
      endpoint,
      p256dh: 'A'.repeat(87),
      auth: 'B'.repeat(22),
      expirationTime: null,
      userAgent: null,
    }),
    true,
  );
};

const summaryTotals = (summary: NotificationRunSummary) => ({
  selected: summary.selected,
  claimed: summary.claimed,
  sent: summary.sent,
  invalidated: summary.invalidated,
  skipped: summary.skipped,
  failed: summary.failed,
  duplicated: summary.duplicated,
});

const noErrorCategories = {
  subscription_gone: 0,
  endpoint_address_blocked: 0,
  push_service_http: 0,
  network_timeout: 0,
  network: 0,
  payload: 0,
  configuration: 0,
  sender: 0,
} as const;

test('scheduler sends each Sunday logical event once to every device', async () => {
  const userId = randomUUID();
  const pushRepository = new InMemoryPushRepository([userId]);
  const programRepository = new InMemoryProgramRepository(userId);
  const progressRepository = new InMemoryProgressRepository(userId);
  const sender = new FakePushSender();
  const clock = new MutableClock(new Date('2026-08-23T06:00:00.000Z'));
  const sundayVideo = programRepository.videoIdsForWeek(1)[6] as string;
  programRepository.markMediaAvailable(1, sundayVideo);
  pushRepository.setDueUsers([
    {
      userId,
      effectiveTimezone: 'Europe/Moscow',
      localDate: '2026-08-23',
      localDayOfWeek: 7,
      workoutReminders: true,
      weeklySurveyReminder: true,
    },
  ]);
  await seedDevice(pushRepository, userId, 'https://push.example.test/device-1');
  await seedDevice(pushRepository, userId, 'https://push.example.test/device-2');
  const scheduler = new NotificationSchedulerService(
    pushRepository,
    programRepository,
    progressRepository,
    new FakeSubscriptionAccessChecker(true),
    sender,
    clock,
    2,
  );

  const firstRun = await scheduler.run();
  assert.deepEqual(summaryTotals(firstRun), {
    selected: 2,
    claimed: 4,
    sent: 4,
    invalidated: 0,
    skipped: 0,
    failed: 0,
    duplicated: 0,
  });
  assert.deepEqual(firstRun.byType, {
    workout_reminder: {
      selected: 1,
      claimed: 2,
      sent: 2,
      invalidated: 0,
      skipped: 0,
      failed: 0,
      duplicated: 0,
    },
    weekly_survey_reminder: {
      selected: 1,
      claimed: 2,
      sent: 2,
      invalidated: 0,
      skipped: 0,
      failed: 0,
      duplicated: 0,
    },
  });
  assert.deepEqual(firstRun.errorCategories, noErrorCategories);
  assert.deepEqual(sender.sent.map(({ payload }) => payload.url).sort(), [
    '/progress',
    '/progress',
    '/schedule',
    '/schedule',
  ]);
  const repeatedRun = await scheduler.run();
  assert.deepEqual(summaryTotals(repeatedRun), {
    selected: 2,
    claimed: 0,
    sent: 0,
    invalidated: 0,
    skipped: 0,
    failed: 0,
    duplicated: 4,
  });
  assert.equal(repeatedRun.byType.workout_reminder.duplicated, 2);
  assert.equal(repeatedRun.byType.weekly_survey_reminder.duplicated, 2);
  assert.equal(sender.sent.length, 4);
});

test('scheduler skips unavailable/completed workouts, submitted metrics and inactive paywall', async () => {
  const userId = randomUUID();
  const pushRepository = new InMemoryPushRepository([userId]);
  const programRepository = new InMemoryProgramRepository(userId);
  const progressRepository = new InMemoryProgressRepository(userId);
  const sender = new FakePushSender();
  const clock = new MutableClock(new Date('2026-08-23T06:00:00.000Z'));
  pushRepository.setDueUsers([
    {
      userId,
      effectiveTimezone: 'Europe/Moscow',
      localDate: '2026-08-23',
      localDayOfWeek: 7,
      workoutReminders: true,
      weeklySurveyReminder: true,
    },
  ]);
  await seedDevice(pushRepository, userId, 'https://push.example.test/device-1');
  await progressRepository.upsertWeeklyMetrics(userId, {
    programWeek: 1,
    energy: 8,
    sleep: 8,
    mood: 8,
    bodySatisfaction: 8,
    note: null,
  });
  const inactive = new FakeSubscriptionAccessChecker(false);
  const scheduler = new NotificationSchedulerService(
    pushRepository,
    programRepository,
    progressRepository,
    inactive,
    sender,
    clock,
  );

  assert.deepEqual(summaryTotals(await scheduler.run()), {
    selected: 0,
    claimed: 0,
    sent: 0,
    invalidated: 0,
    skipped: 1,
    failed: 0,
    duplicated: 0,
  });

  inactive.setActive(true);
  assert.deepEqual(summaryTotals(await scheduler.run()), {
    selected: 0,
    claimed: 0,
    sent: 0,
    invalidated: 0,
    skipped: 1,
    failed: 0,
    duplicated: 0,
  });
  assert.equal(sender.sent.length, 0);
});

test('scheduler honors disabled preferences and completed workout state', async () => {
  const userId = randomUUID();
  const pushRepository = new InMemoryPushRepository([userId]);
  const programRepository = new InMemoryProgramRepository(userId);
  const progressRepository = new InMemoryProgressRepository(userId);
  const sender = new FakePushSender();
  const clock = new MutableClock(new Date('2026-08-17T06:00:00.000Z'));
  const mondayVideo = programRepository.videoIdsForWeek(1)[0] as string;
  programRepository.markMediaAvailable(1, mondayVideo);
  await seedDevice(pushRepository, userId, 'https://push.example.test/device-1');
  pushRepository.setDueUsers([
    {
      userId,
      effectiveTimezone: 'Europe/Moscow',
      localDate: '2026-08-17',
      localDayOfWeek: 1,
      workoutReminders: false,
      weeklySurveyReminder: false,
    },
  ]);
  const scheduler = new NotificationSchedulerService(
    pushRepository,
    programRepository,
    progressRepository,
    new FakeSubscriptionAccessChecker(true),
    sender,
    clock,
  );

  assert.equal((await scheduler.run()).selected, 0);
  await programRepository.completeWorkout(userId, mondayVideo, 1);
  pushRepository.setDueUsers([
    {
      userId,
      effectiveTimezone: 'Europe/Moscow',
      localDate: '2026-08-17',
      localDayOfWeek: 1,
      workoutReminders: true,
      weeklySurveyReminder: false,
    },
  ]);
  assert.equal((await scheduler.run()).selected, 0);
  assert.equal(sender.sent.length, 0);
});

test('scheduler isolates invalid and transient endpoints and never retries an occurrence', async () => {
  const userId = randomUUID();
  const firstEndpoint = 'https://push.example.test/invalid';
  const secondEndpoint = 'https://push.example.test/transient';
  const blockedEndpoint = 'https://push.example.test/blocked-address';
  const pushRepository = new InMemoryPushRepository([userId]);
  const programRepository = new InMemoryProgramRepository(userId);
  const progressRepository = new InMemoryProgressRepository(userId);
  const sender = new FakePushSender();
  const clock = new MutableClock(new Date('2026-08-17T06:00:00.000Z'));
  const mondayVideo = programRepository.videoIdsForWeek(1)[0] as string;
  programRepository.markMediaAvailable(1, mondayVideo);
  pushRepository.setDueUsers([
    {
      userId,
      effectiveTimezone: 'Europe/Moscow',
      localDate: '2026-08-17',
      localDayOfWeek: 1,
      workoutReminders: true,
      weeklySurveyReminder: false,
    },
  ]);
  await seedDevice(pushRepository, userId, firstEndpoint);
  await seedDevice(pushRepository, userId, secondEndpoint);
  await seedDevice(pushRepository, userId, blockedEndpoint);
  sender.setOutcome(firstEndpoint, { kind: 'invalid', errorCode: 'http_410' });
  sender.setOutcome(secondEndpoint, { kind: 'failed', errorCode: 'http_503' });
  sender.setOutcome(blockedEndpoint, {
    kind: 'failed',
    errorCode: 'endpoint_address_blocked',
  });
  const scheduler = new NotificationSchedulerService(
    pushRepository,
    programRepository,
    progressRepository,
    new FakeSubscriptionAccessChecker(true),
    sender,
    clock,
  );

  const firstRun = await scheduler.run();
  assert.deepEqual(summaryTotals(firstRun), {
    selected: 1,
    claimed: 3,
    sent: 0,
    invalidated: 1,
    skipped: 0,
    failed: 2,
    duplicated: 0,
  });
  assert.deepEqual(firstRun.byType.workout_reminder, {
    selected: 1,
    claimed: 3,
    sent: 0,
    invalidated: 1,
    skipped: 0,
    failed: 2,
    duplicated: 0,
  });
  assert.deepEqual(firstRun.errorCategories, {
    ...noErrorCategories,
    subscription_gone: 1,
    endpoint_address_blocked: 1,
    push_service_http: 1,
  });
  assert.equal(JSON.stringify(firstRun).includes('push.example.test'), false);
  assert.equal(
    pushRepository.peekSubscriptions().find(({ endpoint }) => endpoint === firstEndpoint)
      ?.disabledAt instanceof Date,
    true,
  );
  assert.equal(
    pushRepository.peekSubscriptions().find(({ endpoint }) => endpoint === secondEndpoint)
      ?.disabledAt,
    null,
  );
  assert.deepEqual(summaryTotals(await scheduler.run()), {
    selected: 1,
    claimed: 0,
    sent: 0,
    invalidated: 0,
    skipped: 0,
    failed: 0,
    duplicated: 2,
  });
  console.log('KINETRA_T13_SCHEDULER=PASS');
});
