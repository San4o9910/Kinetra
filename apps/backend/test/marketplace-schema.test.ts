import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  marketOfferSchema,
  marketOfferDraftSchema,
  marketProfileSchema,
  marketQuerySchema,
  marketReviewSchema,
} from '../src/marketplace/schema.js';
export const offerFixture = {
  title: 'Техника плавания',
  summary: 'Работа над техникой кроля',
  description: 'Четыре недели заданий и разбора техники.',
  discipline: 'swimming',
  kind: 'program',
  level: 'beginner',
  price_kopecks: 350000,
  payment_period: 'once',
  access_days: 30,
  start_policy: 'После назначения программы',
  includes: 'Программа на четыре недели',
  requirements: 'Умение плавать, бассейн со спасателем',
  feedback: 'Самостоятельные занятия',
  nutrition: 'none',
  response_hours: null,
  video_reviews: 0,
  meetings: 0,
  capacity: null,
  application_required: false,
  cancellation_terms: 'Запрос через поддержку',
  sample_text: '4 × 25 м в спокойном темпе',
};
test('marketplace separates incomplete drafts from publishable offers', () => {
  assert.ok(marketOfferSchema.safeParse(offerFixture).success);
  const incomplete = { ...offerFixture, summary: '', price_kopecks: 0 };
  assert.ok(marketOfferDraftSchema.safeParse(incomplete).success);
  assert.equal(marketOfferSchema.safeParse(incomplete).success, false);
});
test('marketplace money uses positive bounded integer kopecks and comparable periods', () => {
  for (const price_kopecks of [-1, 1.5, 0, 100_000_001, Infinity, NaN])
    assert.equal(marketOfferSchema.safeParse({ ...offerFixture, price_kopecks }).success, false);
  assert.equal(
    marketOfferSchema.safeParse({ ...offerFixture, payment_period: 'month' }).success,
    false,
  );
  assert.equal(
    marketOfferSchema.safeParse({ ...offerFixture, kind: 'coaching', payment_period: 'month' })
      .success,
    false,
  );
  assert.ok(
    marketOfferSchema.safeParse({
      ...offerFixture,
      kind: 'coaching',
      payment_period: 'month',
      response_hours: 24,
      capacity: 10,
    }).success,
  );
});
test('marketplace rejects authority, commission and private media injected into a product', () => {
  for (const extra of [
    { trainer_id: 'other' },
    { is_listed: true },
    { commission_percent: 12 },
    { lesson_id: 'private' },
    { verified: true },
  ])
    assert.equal(marketOfferDraftSchema.safeParse({ ...offerFixture, ...extra }).success, false);
});
test('marketplace public profile has an explicit allowlist and bounded disciplines', () => {
  const profile = {
    display_name: 'Тренер',
    headline: 'Обучаю плаванию',
    bio: 'Опыт работы',
    city: 'Ростов-на-Дону',
    approach: 'Поэтапно',
    disciplines: ['swimming'],
    languages: ['Русский'],
    faq: [],
  };
  assert.ok(marketProfileSchema.safeParse(profile).success);
  assert.equal(
    marketProfileSchema.safeParse({ ...profile, disciplines: ['swimming', 'swimming'] }).success,
    false,
  );
  assert.equal(marketProfileSchema.safeParse({ ...profile, passport: 'private' }).success, false);
  assert.equal(marketProfileSchema.safeParse({ ...profile, verified: true }).success, false);
});
test('marketplace query bounds pagination and review requires reason and current version', () => {
  assert.ok(
    marketQuerySchema.safeParse({ q: '%', page: '2', kind: 'program', period: 'once' }).success,
  );
  for (const query of [
    { page: 0 },
    { page: 1.5 },
    { page: 1001 },
    { q: ['a', 'b'] },
    { trainer_id: 'other' },
  ])
    assert.equal(marketQuerySchema.safeParse(query).success, false);
  assert.equal(
    marketReviewSchema.safeParse({ revision: 1, action: 'suspend', note: '' }).success,
    false,
  );
  assert.equal(
    marketReviewSchema.safeParse({ revision: 0, action: 'approve', note: '' }).success,
    false,
  );
  assert.ok(marketReviewSchema.safeParse({ revision: 1, action: 'approve', note: '' }).success);
});
