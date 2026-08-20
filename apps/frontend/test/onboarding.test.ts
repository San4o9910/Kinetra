import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ONBOARDING_SLIDE_COUNT,
  ONBOARDING_SWIPE_THRESHOLD,
  onboardingSlides,
  parseStoredOnboardingSlide,
  parseStoredOnboardingSlideForUser,
  slideAfterSwipe,
  weekRhythms,
} from '../src/features/onboarding/model.js';

test('onboarding carousel contains all six exact specification slides', () => {
  assert.equal(onboardingSlides.length, 6);
  assert.equal(ONBOARDING_SLIDE_COUNT, 6);
  assert.deepEqual(onboardingSlides, [
    {
      title: 'Добро пожаловать в Kinetra',
      subtitle:
        'Это не просто тренировки. Это образ жизни, который делает вас сильнее, гибче и энергичнее',
    },
    {
      title: 'Активность не тратит энергию. Она её создаёт',
      subtitle:
        'Каждое занятие — это вклад в вашу бодрость, ясность ума и уверенность в себе. Вы почувствуете разницу уже через 2 недели',
    },
    { title: '7 ритмов недели' },
    {
      title: 'Изучите базу',
      subtitle:
        'Мы научим вас 7 базовым движениям, которые лежат в основе любых тренировок. Это убережёт от травм и сделает каждое упражнение осмысленным',
    },
    {
      title: 'Вы сможете двигаться свободно и без боли',
      subtitle:
        'Подниматься по лестнице без одышки, носить сумки без напряжения в спине, играть с детьми и не бояться падений. Это и есть настоящая сила',
    },
    { title: 'Готовы начать?' },
  ]);
});

test('stored slide progress is restored only for the same authenticated user', () => {
  assert.equal(parseStoredOnboardingSlideForUser('4', 'user-a', 'user-a'), 4);
  assert.equal(parseStoredOnboardingSlideForUser('4', 'user-a', 'user-b'), 0);
  assert.equal(parseStoredOnboardingSlideForUser('4', null, 'user-a'), 0);
});

test('weekly rhythm slide contains the seven prescribed day labels', () => {
  assert.deepEqual(
    weekRhythms.map(({ day, label }) => `${day} — ${label}`),
    [
      'Пн — Дыхание',
      'Вт — Сила',
      'Ср — Тело мой дом',
      'Чт — Функционал',
      'Пт — Растяжка',
      'Сб — Нейрогимнастика',
      'Вс — Питание',
    ],
  );
});

test('stored onboarding slide is restored only when it is a valid zero-based slide index', () => {
  assert.equal(parseStoredOnboardingSlide(null), 0);
  assert.equal(parseStoredOnboardingSlide(''), 0);
  assert.equal(parseStoredOnboardingSlide('0'), 0);
  assert.equal(parseStoredOnboardingSlide('3'), 3);
  assert.equal(parseStoredOnboardingSlide('5'), 5);
  assert.equal(parseStoredOnboardingSlide('-1'), 0);
  assert.equal(parseStoredOnboardingSlide('6'), 0);
  assert.equal(parseStoredOnboardingSlide('2.5'), 0);
  assert.equal(parseStoredOnboardingSlide('not-a-slide'), 0);
});

test('swipe navigation respects its threshold, axis, and carousel boundaries', () => {
  assert.equal(slideAfterSwipe(0, -ONBOARDING_SWIPE_THRESHOLD), 1);
  assert.equal(slideAfterSwipe(2, ONBOARDING_SWIPE_THRESHOLD), 1);
  assert.equal(slideAfterSwipe(2, -(ONBOARDING_SWIPE_THRESHOLD - 1)), 2);
  assert.equal(slideAfterSwipe(2, 20, 100), 2);
  assert.equal(slideAfterSwipe(2, -80, 80), 2);
  assert.equal(slideAfterSwipe(0, ONBOARDING_SWIPE_THRESHOLD * 2), 0);
  assert.equal(slideAfterSwipe(5, -ONBOARDING_SWIPE_THRESHOLD * 2), 5);
});
