import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COACH_PACKAGES, coachLevel, coachPackageQuote } from '@kinetra/shared';
test('coach packages charge the exact monthly seat price with progressive volume savings', () => {
  assert.deepEqual(
    COACH_PACKAGES.map((p) => coachPackageQuote(p.id).monthly),
    [1225, 2240, 3625, 3900],
  );
  assert.deepEqual(
    COACH_PACKAGES.map((p) => coachPackageQuote(p.id).introductory),
    [735, 1344, 2175, 2340],
  );
  assert.deepEqual(coachPackageQuote('practice', 30, 2), {
    seats: 16,
    monthly: 2640,
    introductory: 1584,
    extra: 400,
  });
  assert.deepEqual(coachPackageQuote('large', 40, 2), {
    seats: 42,
    monthly: 5500,
    introductory: 3300,
    extra: 300,
  });
  assert.throws(() => coachPackageQuote('large', 29));
  assert.throws(() => coachPackageQuote('start', 30, -1));
  assert.throws(() => coachPackageQuote('unknown'));
  assert.throws(() => coachPackageQuote('large', NaN));
});
test('coach quality cannot be invented from volume and one student cannot unlock a high level', () => {
  assert.equal(
    coachLevel({ active_students: 50, ready_lessons: 50, review_count: 0, rating: null }).level,
    'Старт',
  );
  assert.equal(
    coachLevel({ active_students: 50, ready_lessons: 50, review_count: 1, rating: 5 }).level,
    'Старт',
  );
  assert.equal(
    coachLevel({ active_students: 7, ready_lessons: 5, review_count: 3, rating: 4 }).level,
    'Практик',
  );
  assert.equal(
    coachLevel({ active_students: 14, ready_lessons: 15, review_count: 5, rating: 4.3 }).level,
    'Наставник',
  );
  assert.equal(
    coachLevel({ active_students: 25, ready_lessons: 30, review_count: 10, rating: 4.6 }).level,
    'Мастер',
  );
  assert.equal(
    coachLevel({ active_students: 25, ready_lessons: 30, review_count: 10, rating: 3.9 }).level,
    'Старт',
  );
});
