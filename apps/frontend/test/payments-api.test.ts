import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AuthSessionResponse,
  CreatePaymentResponse,
  SubscriptionResponse,
} from '@kinetra/shared';

import { ApiClient } from '../src/lib/api.js';

const session: AuthSessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000011',
    email: 'payments@example.com',
    phone: null,
    emailVerified: true,
    createdAt: '2026-08-21T00:00:00.000Z',
  },
  accessToken: 'payments-token',
  tokenType: 'Bearer',
  expiresIn: 900,
};

const createdPayment: CreatePaymentResponse = {
  payment_id: 'yookassa-payment-11',
  confirmation_url: 'https://yookassa.ru/checkout/yookassa-payment-11',
  status: 'pending',
};

const canceledRenewal: SubscriptionResponse = {
  status: 'active',
  provider: 'yukassa',
  starts_at: '2026-08-21T00:00:00.000Z',
  expires_at: '2026-09-20T00:00:00.000Z',
  amount: 799,
  currency: 'RUB',
  auto_renew: false,
  days_remaining: 30,
};

test('T11 API client creates a payment and cancels only auto-renewal with JWT auth', async () => {
  const calls: Array<{
    readonly path: string;
    readonly method: string;
    readonly authorization: string | null;
    readonly contentType: string | null;
    readonly body: BodyInit | null | undefined;
  }> = [];
  const client = new ApiClient({
    baseUrl: 'http://api.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        contentType: headers.get('content-type'),
        body: init?.body,
      });

      if (url.pathname === '/api/v1/auth/refresh') {
        return Response.json(session);
      }

      if (url.pathname === '/api/v1/payments/create') {
        return Response.json(createdPayment);
      }

      if (url.pathname === '/api/v1/payments/cancel-subscription') {
        return Response.json(canceledRenewal);
      }

      throw new Error(`Unexpected request ${url.pathname}`);
    },
  });

  const returnUrl = 'https://app.kinetra.ru/payment/success';
  assert.deepEqual(await client.createPayment(returnUrl), createdPayment);
  assert.deepEqual(await client.cancelSubscription(), canceledRenewal);
  assert.deepEqual(calls.slice(1), [
    {
      path: '/api/v1/payments/create',
      method: 'POST',
      authorization: 'Bearer payments-token',
      contentType: 'application/json',
      body: JSON.stringify({ return_url: returnUrl }),
    },
    {
      path: '/api/v1/payments/cancel-subscription',
      method: 'POST',
      authorization: 'Bearer payments-token',
      contentType: null,
      body: undefined,
    },
  ]);
});
