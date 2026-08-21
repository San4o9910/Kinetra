import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CreatePaymentResponse, SubscriptionResponse } from '@kinetra/shared';

import { PaymentCancelScreen } from '../src/features/payments/PaymentCancelScreen.js';
import { PaymentSuccessScreen } from '../src/features/payments/PaymentSuccessScreen.js';
import { PaymentView } from '../src/features/payments/PaymentView.js';
import { SubscriptionPaywallDialog } from '../src/features/payments/SubscriptionPaywallDialog.js';
import {
  PAYMENT_POLL_INTERVAL_MS,
  PAYMENT_POLL_TIMEOUT_MS,
  PAYMENT_PRICE_LABEL,
  beginPayment,
  isSubscriptionActive,
  paymentBenefits,
  pollForActiveSubscription,
} from '../src/features/payments/model.js';
import { withoutWorkoutHistorySentinel } from '../src/features/program/history.js';
import { ProgramScreen } from '../src/features/program/ProgramScreen.js';

const pendingSubscription: SubscriptionResponse = {
  status: 'pending',
  provider: 'yukassa',
  starts_at: null,
  expires_at: null,
  amount: 799,
  currency: 'RUB',
  auto_renew: true,
  days_remaining: null,
};

const activeSubscription: SubscriptionResponse = {
  ...pendingSubscription,
  status: 'active',
  starts_at: '2026-08-21T10:00:00.000Z',
  expires_at: '2026-09-20T10:00:00.000Z',
  days_remaining: 30,
};

const expiredSubscription: SubscriptionResponse = {
  ...activeSubscription,
  status: 'expired',
  expires_at: '2026-08-20T10:00:00.000Z',
  auto_renew: false,
  days_remaining: 0,
};

test('T11 payment page renders the exact price, benefits and renewal disclosure', () => {
  const markup = renderToStaticMarkup(
    createElement(PaymentView, {
      busy: false,
      error: null,
      onBack: () => undefined,
      onSubmit: () => undefined,
    }),
  );

  assert.ok(markup.includes('data-testid="payment-screen"'));
  assert.ok(markup.includes('Kinetra Premium'));
  assert.ok(markup.includes(PAYMENT_PRICE_LABEL));
  assert.ok(markup.includes('data-testid="create-payment"'));
  assert.ok(markup.includes('Оформить подписку'));
  assert.ok(markup.includes('Подписка продлевается автоматически'));
  assert.equal((markup.match(/class="payment-benefit-icon"/gu) ?? []).length, 5);

  for (const benefit of paymentBenefits) {
    assert.ok(markup.includes(benefit));
  }
});

test('T11 result pages and expired paywall expose canonical actions and copy', () => {
  const success = renderToStaticMarkup(
    createElement(PaymentSuccessScreen, {
      onActivated: () => undefined,
      onContinue: () => undefined,
      onSessionExpired: () => undefined,
    }),
  );
  assert.ok(success.includes('Оплата прошла успешно!'));
  assert.ok(success.includes('data-testid="payment-success-status"'));
  assert.ok(success.includes('data-testid="start-training"'));

  const cancel = renderToStaticMarkup(
    createElement(PaymentCancelScreen, {
      onRetry: () => undefined,
      onLater: () => undefined,
    }),
  );
  assert.ok(cancel.includes('Оплата не завершена'));
  assert.ok(cancel.includes('data-testid="retry-payment"'));
  assert.ok(cancel.includes('data-testid="payment-later"'));

  const paywall = renderToStaticMarkup(
    createElement(SubscriptionPaywallDialog, {
      open: true,
      subscription: expiredSubscription,
      onClose: () => undefined,
      onRenew: () => undefined,
    }),
  );
  assert.ok(paywall.includes('data-testid="subscription-paywall-dialog"'));
  assert.ok(paywall.includes('Подписка истекла'));
  assert.ok(paywall.includes('data-testid="paywall-renew"'));
  assert.ok(paywall.includes('data-testid="paywall-close"'));
});

test('inactive subscription renders a locked T07 surface without rendering a player', () => {
  const markup = renderToStaticMarkup(
    createElement(ProgramScreen, {
      timezone: 'Europe/Moscow',
      subscription: expiredSubscription,
      onOpenPayment: () => undefined,
      onSubscriptionRequired: () => undefined,
      onWorkoutCompletionBusyChange: () => undefined,
      onSessionExpired: () => undefined,
    }),
  );

  assert.ok(markup.includes('data-testid="program-subscription-locked"'));
  assert.ok(markup.includes('data-testid="subscription-paywall-dialog"'));
  assert.equal(markup.includes('data-testid="workout-player"'), false);
  assert.equal(markup.includes('data-testid="main-screen"'), false);
});

test('inactive entitlement removes both workout sentinels while preserving unrelated history', () => {
  assert.deepEqual(
    withoutWorkoutHistorySentinel({
      kinetraWorkoutVideoId: 'video-7',
      kinetraProgramWeek: 4,
      navigationId: 'keep-me',
    }),
    { navigationId: 'keep-me' },
  );
  assert.equal(withoutWorkoutHistorySentinel({ kinetraWorkoutVideoId: 'video-7' }), null);

  const untouched = { navigationId: 'unchanged' };
  assert.equal(withoutWorkoutHistorySentinel(untouched), untouched);
});

test('payment operation forwards the return URL and redirects exactly once', async () => {
  const calls: string[] = [];
  const response: CreatePaymentResponse = {
    payment_id: 'payment-1',
    confirmation_url: 'https://yookassa.ru/checkout/payment-1',
    status: 'pending',
  };

  const result = await beginPayment(
    'https://app.kinetra.ru/payment/success',
    async (returnUrl) => {
      calls.push(`create:${returnUrl}`);
      return response;
    },
    (confirmationUrl) => calls.push(`redirect:${confirmationUrl}`),
  );

  assert.equal(result, response);
  assert.deepEqual(calls, [
    'create:https://app.kinetra.ru/payment/success',
    'redirect:https://yookassa.ru/checkout/payment-1',
  ]);
});

test('success polling is non-overlapping and stops on active or at 30 seconds', async () => {
  const simulationStart = Date.parse('2026-08-21T12:00:00.000Z');
  let clock = simulationStart;
  let fetches = 0;
  let concurrent = 0;
  let maximumConcurrent = 0;
  const controller = new AbortController();
  const activeResult = await pollForActiveSubscription({
    signal: controller.signal,
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
    fetchSubscription: async () => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      fetches += 1;
      const result = fetches === 1 ? pendingSubscription : activeSubscription;
      concurrent -= 1;
      return result;
    },
  });

  assert.equal(activeResult.kind, 'active');
  assert.equal(fetches, 2);
  assert.equal(maximumConcurrent, 1);
  assert.equal(clock, simulationStart + PAYMENT_POLL_INTERVAL_MS);

  clock = simulationStart;
  fetches = 0;
  const timeoutResult = await pollForActiveSubscription({
    signal: new AbortController().signal,
    timeoutMs: PAYMENT_POLL_TIMEOUT_MS,
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
    fetchSubscription: async () => {
      fetches += 1;
      return pendingSubscription;
    },
  });

  assert.equal(timeoutResult.kind, 'timeout');
  assert.equal(clock, simulationStart + PAYMENT_POLL_TIMEOUT_MS);
  assert.equal(fetches, 16);
  assert.equal(timeoutResult.subscription, pendingSubscription);
});

test('success polling hard deadline aborts a hung fetch and preserves caller cancellation', async () => {
  let expireDeadline = (): void => {
    throw new Error('Deadline was not registered.');
  };
  let deadlineDelay = 0;
  let deadlineCanceled = false;
  let hungFetchSignal: AbortSignal | null = null;

  const hungResultPromise = pollForActiveSubscription({
    signal: new AbortController().signal,
    timeoutMs: PAYMENT_POLL_TIMEOUT_MS,
    scheduleDeadline: (milliseconds, onDeadline) => {
      deadlineDelay = milliseconds;
      expireDeadline = onDeadline;
      return () => {
        deadlineCanceled = true;
      };
    },
    fetchSubscription: (signal) => {
      hungFetchSignal = signal;
      return new Promise<SubscriptionResponse>(() => undefined);
    },
  });

  expireDeadline();
  const hungResult = await hungResultPromise;

  assert.equal(deadlineDelay, PAYMENT_POLL_TIMEOUT_MS);
  assert.deepEqual(hungResult, { kind: 'timeout', subscription: null });
  assert.equal(hungFetchSignal?.aborted, true);
  assert.equal(deadlineCanceled, true);

  const caller = new AbortController();
  let callerDeadlineCanceled = false;
  let callerFetchSignal: AbortSignal | null = null;
  const callerResultPromise = pollForActiveSubscription({
    signal: caller.signal,
    scheduleDeadline: () => () => {
      callerDeadlineCanceled = true;
    },
    fetchSubscription: (signal) => {
      callerFetchSignal = signal;
      return new Promise<SubscriptionResponse>(() => undefined);
    },
  });

  caller.abort();
  await assert.rejects(
    callerResultPromise,
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(callerFetchSignal?.aborted, true);
  assert.equal(callerDeadlineCanceled, true);
});

test('active entitlement checks status and exact period boundaries', () => {
  assert.equal(isSubscriptionActive(activeSubscription, Date.parse('2026-08-21T12:00:00Z')), true);
  assert.equal(
    isSubscriptionActive(expiredSubscription, Date.parse('2026-08-21T12:00:00Z')),
    false,
  );
  assert.equal(
    isSubscriptionActive(activeSubscription, Date.parse(activeSubscription.expires_at ?? '')),
    false,
  );
  assert.equal(isSubscriptionActive(pendingSubscription), false);
  assert.equal(isSubscriptionActive({ ...activeSubscription, starts_at: null }), false);
  assert.equal(isSubscriptionActive({ ...activeSubscription, expires_at: null }), false);
  assert.equal(isSubscriptionActive(null), false);
});
