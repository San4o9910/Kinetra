import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { test } from 'node:test';

import webPush from 'web-push';

import {
  createRestrictedPushAgent,
  createRestrictedPushLookup,
  type PushDnsResolver,
} from '../src/push/network-security.js';
import type { PushDeviceSubscription } from '../src/push/repository.js';
import {
  createWebPushTransport,
  WebPushSender,
  type PushPayload,
  type WebPushRequestPrimitive,
  type WebPushTransport,
} from '../src/push/webpush-sender.js';

const subscription: PushDeviceSubscription = {
  endpoint: 'https://push.example.test/subscriptions/device-1',
  p256dh: 'A'.repeat(87),
  auth: 'B'.repeat(22),
  expirationTime: null,
};

const payload: PushPayload = {
  type: 'workout_reminder',
  title: 'Время тренировки',
  body: 'Откройте расписание Kinetra.',
  url: '/schedule',
  occurrence_key: 'workout:1:video-1:2026-08-23',
};

const resolveWithLookup = (
  lookup: LookupFunction,
  hostname: string,
): Promise<readonly LookupAddress[]> =>
  new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error !== null) {
        reject(error);
        return;
      }

      if (!Array.isArray(addresses)) {
        reject(new Error('Expected lookup to return every resolved address.'));
        return;
      }

      resolve(addresses);
    });
  });

const connectWithAgent = (agent: Agent): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: 'push-private.example',
        method: 'POST',
        port: 443,
        agent,
      },
      () => resolve(),
    );
    request.once('error', reject);
    request.end();
  });

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('HTTP test server did not expose a TCP port.');
  }

  return address.port;
};

const close = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
};

const localHttpRequestPrimitive =
  (port: number): WebPushRequestPrimitive =>
  (endpoint, options, onResponse) => {
    const url = new URL(endpoint);

    return httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: options.headers,
      },
      onResponse,
    );
  };

const validTransportSubscription = (endpoint: string): PushDeviceSubscription => {
  const keyAgreement = createECDH('prime256v1');
  keyAgreement.generateKeys();

  return {
    endpoint,
    p256dh: keyAgreement.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
    expirationTime: null,
  };
};

test('Web Push sender uses bounded options and sends only the compact public payload', async () => {
  let capturedPayload = '';
  const capturedOptions: Parameters<WebPushTransport['sendNotification']>[2][] = [];
  const transport: WebPushTransport = {
    sendNotification: async (_capturedSubscription, serialized, options) => {
      capturedPayload = serialized;
      capturedOptions.push(options);
      return {};
    },
  };
  const sender = new WebPushSender(
    {
      subject: 'mailto:coach@kinetra.test',
      publicKey: 'P'.repeat(87),
      privateKey: 'S'.repeat(43),
    },
    transport,
  );

  assert.deepEqual(await sender.send(subscription, payload), { kind: 'sent' });
  assert.deepEqual(JSON.parse(capturedPayload) as unknown, payload);
  assert.equal(capturedPayload.includes('S'.repeat(43)), false);
  assert.equal(capturedOptions[0]?.TTL, 3_600);
  assert.equal(capturedOptions[0]?.urgency, 'normal');
  assert.equal(capturedOptions[0]?.timeout, 10_000);
  assert.equal(capturedOptions[0]?.agent instanceof Agent, true);
  assert.equal(typeof capturedOptions[0]?.agent.options.lookup, 'function');
});

test('Web Push connection lookup rejects private or reserved DNS results and allows public results', async () => {
  const privateResolver: PushDnsResolver = async () => [{ address: '10.20.30.40', family: 4 }];
  const privateLookup = createRestrictedPushLookup(privateResolver);

  await assert.rejects(resolveWithLookup(privateLookup, 'push-private.example'), (error) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ERR_PUSH_ENDPOINT_ADDRESS_BLOCKED');
    assert.equal(String(error).includes('push-private.example'), false);
    return true;
  });
  await assert.rejects(connectWithAgent(createRestrictedPushAgent(privateResolver)), {
    code: 'ERR_PUSH_ENDPOINT_ADDRESS_BLOCKED',
  });

  const mixedResolver: PushDnsResolver = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2001:db8::1', family: 6 },
  ];
  await assert.rejects(
    resolveWithLookup(createRestrictedPushLookup(mixedResolver), 'push-rebind.example'),
    { code: 'ERR_PUSH_ENDPOINT_ADDRESS_BLOCKED' },
  );

  const publicAddresses = [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ] as const;
  const publicResolver: PushDnsResolver = async () => publicAddresses;
  assert.deepEqual(
    await resolveWithLookup(createRestrictedPushLookup(publicResolver), 'push-public.example'),
    publicAddresses,
  );
});

test(
  'Web Push transport discards a streaming response and enforces a wall-clock deadline',
  { timeout: 3_000 },
  async () => {
    let chunksSent = 0;
    const server = createServer((request, response) => {
      if (request.url === '/gone' || request.url === '/unavailable') {
        response.writeHead(request.url === '/gone' ? 410 : 503, {
          'content-type': 'text/plain',
        });
        response.end('provider details are intentionally ignored');
        return;
      }

      if (request.url === '/accepted') {
        response.writeHead(201);
        response.end();
        return;
      }

      response.writeHead(201, { 'content-type': 'application/octet-stream' });
      response.flushHeaders();
      const stream = setInterval(() => {
        chunksSent += 1;
        response.write(Buffer.alloc(8_192, chunksSent % 251));
      }, 5);
      response.once('close', () => clearInterval(stream));
    });

    try {
      const port = await listen(server);
      const vapidDetails = {
        subject: 'mailto:coach@kinetra.test',
        ...webPush.generateVAPIDKeys(),
      };
      const hardDeadlineMs = 400;
      const sender = new WebPushSender(
        vapidDetails,
        createWebPushTransport(localHttpRequestPrimitive(port)),
        3_600,
        hardDeadlineMs,
      );
      const startedAt = performance.now();
      const outcome = await sender.send(
        validTransportSubscription(`https://push-stream.test:${port}/stream`),
        payload,
      );
      const elapsedMs = performance.now() - startedAt;

      assert.deepEqual(outcome, { kind: 'failed', errorCode: 'network_timeout' });
      assert.ok(chunksSent >= 3, `expected continuous chunks, received ${chunksSent}`);
      assert.ok(elapsedMs >= hardDeadlineMs * 0.75, `deadline fired too early: ${elapsedMs}ms`);
      assert.ok(elapsedMs < 1_500, `stream defeated the hard deadline: ${elapsedMs}ms`);
      assert.ok(chunksSent < 200, `streaming response was not bounded: ${chunksSent} chunks`);

      assert.deepEqual(
        await sender.send(
          validTransportSubscription(`https://push-stream.test:${port}/gone`),
          payload,
        ),
        { kind: 'invalid', errorCode: 'http_410' },
      );
      assert.deepEqual(
        await sender.send(
          validTransportSubscription(`https://push-stream.test:${port}/unavailable`),
          payload,
        ),
        { kind: 'failed', errorCode: 'http_503' },
      );
      assert.deepEqual(
        await sender.send(
          validTransportSubscription(`https://push-stream.test:${port}/accepted`),
          payload,
        ),
        { kind: 'sent' },
      );
    } finally {
      await close(server);
    }
  },
);

test('Web Push sender invalidates only 404/410 and safely categorizes other failures', async () => {
  for (const [statusCode, expected] of [
    [404, { kind: 'invalid', errorCode: 'http_404' }],
    [410, { kind: 'invalid', errorCode: 'http_410' }],
    [401, { kind: 'failed', errorCode: 'http_401' }],
    [403, { kind: 'failed', errorCode: 'http_403' }],
    [429, { kind: 'failed', errorCode: 'http_429' }],
    [503, { kind: 'failed', errorCode: 'http_503' }],
  ] as const) {
    const transport: WebPushTransport = {
      sendNotification: async () => {
        throw { statusCode };
      },
    };
    const sender = new WebPushSender(
      {
        subject: 'mailto:coach@kinetra.test',
        publicKey: 'P'.repeat(87),
        privateKey: 'S'.repeat(43),
      },
      transport,
    );
    assert.deepEqual(await sender.send(subscription, payload), expected);
  }

  const timeoutTransport: WebPushTransport = {
    sendNotification: async () => {
      const error = new Error('secret provider details must not escape');
      error.name = 'TimeoutError';
      throw error;
    },
  };
  const timeoutSender = new WebPushSender(
    {
      subject: 'mailto:coach@kinetra.test',
      publicKey: 'P'.repeat(87),
      privateKey: 'S'.repeat(43),
    },
    timeoutTransport,
  );
  assert.deepEqual(await timeoutSender.send(subscription, payload), {
    kind: 'failed',
    errorCode: 'network_timeout',
  });
});

test('Web Push sender rejects mismatched deep links and oversized payloads before transport', async () => {
  let requests = 0;
  const transport: WebPushTransport = {
    sendNotification: async () => {
      requests += 1;
      return {};
    },
  };
  const sender = new WebPushSender(
    {
      subject: 'mailto:coach@kinetra.test',
      publicKey: 'P'.repeat(87),
      privateKey: 'S'.repeat(43),
    },
    transport,
  );

  assert.deepEqual(
    await sender.send(subscription, {
      ...payload,
      url: 'https://attacker.example' as PushPayload['url'],
    }),
    { kind: 'failed', errorCode: 'invalid_payload' },
  );
  assert.deepEqual(await sender.send(subscription, { ...payload, body: 'x'.repeat(3_500) }), {
    kind: 'failed',
    errorCode: 'invalid_payload',
  });
  assert.deepEqual(
    await sender.send(
      { ...subscription, endpoint: 'https://192.0.2.1/subscriptions/device-1' },
      payload,
    ),
    { kind: 'failed', errorCode: 'endpoint_address_blocked' },
  );
  assert.equal(requests, 0);
  console.log('KINETRA_T13_WEBPUSH_SENDER=PASS');
});
