import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createSurveyDraft,
  isSurveyStepValid,
  surveyDraftToSubmission,
  toggleSurveyInjury,
  type SurveyDraft,
} from '../src/features/survey/model.js';
import {
  appRoutes,
  isActiveAppRoute,
  isPaymentRoute,
  normalizeAppRoute,
  routeForOnboardingStatus,
} from '../src/routing.js';

const completeDraft = (): SurveyDraft => ({
  gender: 'male',
  ageRange: '26-35',
  goal: 'general_health',
  injuries: ['none'],
  injuriesDetail: '',
  experience: 'novice',
});

test('server onboarding statuses map to canonical browser routes', () => {
  assert.equal(routeForOnboardingStatus('survey_pending'), appRoutes.survey);
  assert.equal(routeForOnboardingStatus('onboarding_pending'), appRoutes.onboarding);
  assert.equal(routeForOnboardingStatus('base_lessons'), appRoutes.baseLessons);
  assert.equal(routeForOnboardingStatus('active'), appRoutes.home);
  assert.equal(normalizeAppRoute('/settings/'), appRoutes.settings);
  assert.equal(normalizeAppRoute('/schedule/'), appRoutes.schedule);
  assert.equal(normalizeAppRoute('/progress/'), appRoutes.progress);
  assert.equal(normalizeAppRoute('/payment/'), appRoutes.payment);
  assert.equal(normalizeAppRoute('/payment/success/'), appRoutes.paymentSuccess);
  assert.equal(normalizeAppRoute('/payment/cancel/'), appRoutes.paymentCancel);
  assert.equal(isPaymentRoute(appRoutes.payment), true);
  assert.equal(isPaymentRoute(appRoutes.paymentSuccess), true);
  assert.equal(isPaymentRoute(appRoutes.paymentCancel), true);
  assert.equal(isPaymentRoute(appRoutes.home), false);
  assert.equal(isActiveAppRoute(appRoutes.home), true);
  assert.equal(isActiveAppRoute(appRoutes.schedule), true);
  assert.equal(isActiveAppRoute(appRoutes.progress), true);
  assert.equal(isActiveAppRoute(appRoutes.settings), true);
  assert.equal(isActiveAppRoute(appRoutes.baseLessons), false);
  assert.equal(normalizeAppRoute('/unknown'), appRoutes.login);
});

test('each survey step rejects missing required data', () => {
  const draft = completeDraft();

  assert.equal(isSurveyStepValid(0, { ...draft, gender: null }), false);
  assert.equal(isSurveyStepValid(1, { ...draft, ageRange: null }), false);
  assert.equal(isSurveyStepValid(2, { ...draft, goal: null }), false);
  assert.equal(isSurveyStepValid(3, { ...draft, injuries: [] }), false);
  assert.equal(isSurveyStepValid(4, { ...draft, experience: null }), false);
});

test('none is exclusive and other requires a bounded description', () => {
  const draft = completeDraft();
  const withKnees = toggleSurveyInjury(draft, 'knees');
  assert.deepEqual(withKnees.injuries, ['knees']);

  const withOther = toggleSurveyInjury(withKnees, 'other');
  assert.deepEqual(withOther.injuries, ['knees', 'other']);
  assert.equal(isSurveyStepValid(3, withOther), false);
  assert.equal(isSurveyStepValid(3, { ...withOther, injuriesDetail: 'Старая травма' }), true);
  assert.equal(isSurveyStepValid(3, { ...withOther, injuriesDetail: 'x'.repeat(501) }), false);

  const backToNone = toggleSurveyInjury(withOther, 'none');
  assert.deepEqual(backToNone.injuries, ['none']);
  assert.equal(backToNone.injuriesDetail, '');
});

test('submission is produced only when all five steps are valid', () => {
  const draft = completeDraft();
  assert.deepEqual(surveyDraftToSubmission(draft), {
    gender: 'male',
    age_range: '26-35',
    goal: 'general_health',
    injuries: ['none'],
    experience: 'novice',
  });
  assert.equal(surveyDraftToSubmission({ ...draft, gender: null }), null);
});

test('edit mode restores the latest server survey into the draft', () => {
  const draft = createSurveyDraft({
    id: '00000000-0000-4000-8000-000000000001',
    version: 2,
    gender: 'female',
    age_range: '36-45',
    goal: 'strength',
    injuries: ['lower_back', 'other'],
    injuries_detail: 'Нужна щадящая нагрузка',
    experience: 'experienced',
    is_current: true,
    created_at: '2026-08-20T00:00:00.000Z',
  });

  assert.equal(draft.gender, 'female');
  assert.equal(draft.ageRange, '36-45');
  assert.deepEqual(draft.injuries, ['lower_back', 'other']);
  assert.equal(draft.injuriesDetail, 'Нужна щадящая нагрузка');
});
