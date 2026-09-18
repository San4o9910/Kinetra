import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { TrainingMedia, parseMediaRange } from '../src/training/media.js';
import { TrainingService } from '../src/training/service.js';
import { planSchema, studentSchema, logSchema } from '../src/training/schema.js';

test('personal program validation rejects invalid dates, duplicate IDs and unsafe content sizes', () => {
  const workout = {
    id: randomUUID(),
    title: 'Приседания',
    instructions: '3 × 12',
    scheduled_date: '2026-09-18',
    duration_minutes: 30,
    lesson_id: null,
  };
  const plan = {
    title: 'Личная программа',
    goal: 'Движение без боли',
    revision: 1,
    workouts: [workout],
  };
  assert.ok(planSchema.safeParse(plan).success);
  assert.equal(planSchema.safeParse({ ...plan, workouts: [workout, workout] }).success, false);
  assert.equal(
    planSchema.safeParse({ ...plan, workouts: [{ ...workout, scheduled_date: '2026-02-31' }] })
      .success,
    false,
  );
  assert.equal(
    planSchema.safeParse({ ...plan, workouts: [{ ...workout, instructions: 'x'.repeat(5001) }] })
      .success,
    false,
  );
  assert.ok(studentSchema.safeParse({ name: 'Анна' }).success);
  assert.equal(logSchema.safeParse({ completed: false }).success, false);
  assert.equal(logSchema.safeParse({ difficulty: 6 }).success, false);
});
test('private lesson links are bound to lesson, user, expiry and signing context', () => {
  const service = new TrainingService({} as Pool, true);
  const media = new TrainingMedia(service, '/tmp/kinetra-training-test', 'test-secret-not-real');
  const id = randomUUID(),
    user = randomUUID(),
    now = 1_000_000;
  const token = media.sign(user, id, now);
  assert.equal(media.verify(token, id, now + 1000), user);
  assert.throws(() => media.verify(token, randomUUID(), now));
  assert.throws(() => media.verify(token, id, now + 300_000));
  assert.throws(() => media.verify(token + 'x', id, now));
  assert.throws(() => new TrainingMedia(service, 'relative', 'secret'));
  assert.throws(() => new TrainingMedia(service, '/tmp/other', 'different').verify(token, id, now));
});
test('video range parsing supports seeking and rejects malformed or multi-range requests', () => {
  assert.deepEqual(parseMediaRange(undefined, 100), { start: 0, end: 99 });
  assert.deepEqual(parseMediaRange('bytes=20-40', 100), { start: 20, end: 40 });
  assert.deepEqual(parseMediaRange('bytes=20-', 100), { start: 20, end: 99 });
  assert.deepEqual(parseMediaRange('bytes=-10', 100), { start: 90, end: 99 });
  for (const value of [
    'bytes=100-',
    'bytes=30-20',
    'bytes=0-1,4-5',
    'bytes=-0',
    'bytes=-',
    'items=0-1',
    'bytes=999999999999999999999-',
  ])
    assert.equal(parseMediaRange(value, 100), null, value);
});
