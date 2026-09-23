import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { marketPrice, type MarketOfferInput } from '@kinetra/shared';
import { OfferContent, ProfileContent } from '../src/features/marketplace/Catalogue.js';
import { isMarketplaceRoute, normalizeAppRoute } from '../src/routing.js';
test('marketplace routes accept only bounded public UUIDs', () => {
  const id = '00000000-0000-4000-8000-000000000301';
  assert.equal(normalizeAppRoute(`/offers/${id}`), `/offers/${id}`);
  assert.equal(normalizeAppRoute(`/coaches/${id}/`), `/coaches/${id}`);
  assert.equal(normalizeAppRoute('/offers/<script>'), '/login');
  assert.equal(normalizeAppRoute(`/offers/${id}/private`), '/login');
  assert.equal(isMarketplaceRoute(normalizeAppRoute('/catalog')), true);
});
test('marketplace offer makes price period, access and included support explicit', () => {
  const offer: MarketOfferInput = {
    title: '<script>alert(1)</script>',
    summary: 'Плавание',
    description: 'Описание',
    discipline: 'swimming',
    kind: 'coaching',
    level: 'beginner',
    price_kopecks: 123456,
    payment_period: 'month',
    access_days: 30,
    start_policy: 'После подтверждения',
    includes: 'Четыре задания',
    requirements: 'Бассейн',
    feedback: 'Чат',
    nutrition: 'personal',
    response_hours: 24,
    video_reviews: 2,
    meetings: 1,
    capacity: 5,
    application_required: true,
    cancellation_terms: 'По заявке',
    sample_text: 'Открытый пример',
  };
  const html = renderToStaticMarkup(createElement(OfferContent, { offer }));
  assert.ok(html.includes('/ месяц'));
  assert.ok(html.includes('30 дней'));
  assert.ok(html.includes('Персональный план питания'));
  assert.ok(html.includes('24 ч.'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('12%'), false);
  assert.equal(html.includes('175 ₽'), false);
  assert.ok(marketPrice({ ...offer, payment_period: 'once' }).endsWith('разово'));
});
test('marketplace profile preview does not invent credentials or testimonials', () => {
  const html = renderToStaticMarkup(
    createElement(ProfileContent, {
      profile: {
        display_name: 'Мария',
        headline: 'Тренер',
        bio: 'О себе',
        city: '',
        approach: 'Занятия',
        disciplines: ['swimming'],
        languages: ['Русский'],
        faq: [],
      },
    }),
  );
  assert.ok(html.includes('Мария'));
  assert.ok(html.includes('Плавание'));
  assert.equal(html.includes('проверена квалификация'), false);
  assert.equal(html.includes('отзывов'), false);
});
