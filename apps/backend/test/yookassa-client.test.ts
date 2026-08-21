import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { test } from 'node:test';

import { HttpYooKassaClient, YooKassaApiError } from '../src/payments/yookassa-client.js';

interface CapturedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly body: unknown;
}

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

test('native YooKassa client sends Basic auth/idempotency and validates provider objects', async () => {
  const captured: CapturedRequest[] = [];
  let rejectNextCreate: false | 400 | 503 = false;
  const payment = {
    id: 'payment-1',
    status: 'pending',
    paid: false,
    amount: { value: '799.00', currency: 'RUB' },
    confirmation: {
      type: 'redirect',
      confirmation_url: 'https://yookassa.test/checkout/payment-1',
    },
    metadata: {
      user_id: '11111111-1111-4111-8111-111111111111',
      subscription_id: '22222222-2222-4222-8222-222222222222',
      attempt_id: '33333333-3333-4333-8333-333333333333',
      type: 'subscription',
    },
  } as const;
  const refund = {
    id: 'refund-1',
    status: 'succeeded',
    payment_id: payment.id,
    amount: payment.amount,
  } as const;
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      captured.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        idempotencyKey: request.headers['idempotence-key'] as string | undefined,
        body,
      });

      if (request.method === 'POST' && request.url === '/v3/payments') {
        if (rejectNextCreate === 400) {
          response.writeHead(400, { 'Content-Type': 'text/plain' });
          response.end('bad request');
        } else if (rejectNextCreate === 503) {
          sendJson(response, 503, { type: 'server_error' });
        } else {
          sendJson(response, 200, payment);
        }
        return;
      }

      if (request.url === '/v3/payments/payment-1') {
        sendJson(response, 200, payment);
        return;
      }

      if (request.url === '/v3/refunds/refund-1') {
        sendJson(response, 200, refund);
        return;
      }

      sendJson(response, 404, { type: 'not_found' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('YooKassa client test server did not expose a TCP address.');
  }

  const client = new HttpYooKassaClient({
    shopId: 'shop-id',
    secretKey: 'secret-key',
    requestTimeoutMs: 2_000,
    baseUrl: `http://127.0.0.1:${address.port}/v3`,
  });
  const createInput = {
    amount: payment.amount,
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: 'https://app.kinetra.test/payment/success',
    },
    description: 'Подписка Kinetra — 1 месяц',
    save_payment_method: true,
    metadata: payment.metadata,
  } as const;

  try {
    assert.deepEqual(await client.createPayment(createInput, 'idem-key-1'), payment);
    assert.deepEqual(await client.getPayment(payment.id), payment);
    assert.deepEqual(await client.getRefund(refund.id), refund);
    assert.equal(captured[0]?.method, 'POST');
    assert.equal(captured[0]?.url, '/v3/payments');
    assert.equal(
      captured[0]?.authorization,
      `Basic ${Buffer.from('shop-id:secret-key').toString('base64')}`,
    );
    assert.equal(captured[0]?.idempotencyKey, 'idem-key-1');
    assert.deepEqual(captured[0]?.body, createInput);

    rejectNextCreate = 503;
    await assert.rejects(
      client.createPayment(createInput, 'idem-key-2'),
      (error: unknown) =>
        error instanceof YooKassaApiError && error.statusCode === 503 && error.retryable === true,
    );

    rejectNextCreate = 400;
    await assert.rejects(
      client.createPayment(createInput, 'idem-key-3'),
      (error: unknown) =>
        error instanceof YooKassaApiError && error.statusCode === 400 && error.retryable === false,
    );
    console.log('KINETRA_T11_YOOKASSA_CLIENT=PASS');
  } finally {
    await closeServer(server);
  }
});
