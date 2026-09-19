import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import type { ConnectionOptions, TLSSocket } from 'node:tls';

import type { SendMailOptions, SMTPSentMessageInfo, SMTPTransportOptions } from 'nodemailer';

import {
  SmtpAuthTokenDelivery,
  type SmtpDeliveryConfig,
  type SmtpDeliveryDependencies,
} from '../src/auth/smtp-delivery.js';

const config: SmtpDeliveryConfig = {
  service: 'yandex',
  username: 'kinetra-owner@yandex.ru',
  password: 'test-app-password-private',
  appOrigin: 'https://kinetra.example',
  timeoutMs: 1_000,
};
const recipient = 'athlete+beta@example.com';
const token = 'opaque_private_token_0123456789ABCDEF';
const reset = {
  userId: 'private-user-id',
  destination: recipient,
  destinationType: 'email' as const,
  token,
  expiresAt: new Date('2030-01-01T12:00:00.000Z'),
};

class FakeSocket extends EventEmitter {
  public authorized = true;
  public destroyed = false;
  public destroyCount = 0;

  public destroy(): this {
    this.destroyCount += 1;
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

const createHarness = () => {
  const socket = new FakeSocket();
  const options: SMTPTransportOptions[] = [];
  const messages: SendMailOptions[] = [];
  const connections: ConnectionOptions[] = [];
  const dnsRequests: string[] = [];
  let cancelled = 0;
  let closed = 0;
  let handedOff = 0;
  let dnsCallback: ((error: NodeJS.ErrnoException | null, addresses: string[]) => void) | undefined;
  let resolveSend: ((result: SMTPSentMessageInfo) => void) | undefined;
  let rejectSend: ((error: Error) => void) | undefined;
  const dependencies: SmtpDeliveryDependencies = {
    createResolver: () => ({
      cancel: () => {
        cancelled += 1;
      },
      resolve4: (host, callback) => {
        dnsRequests.push(host);
        dnsCallback = callback;
      },
    }),
    connect: (connectionOptions) => {
      connections.push(connectionOptions);
      return socket as unknown as TLSSocket;
    },
    createTransport: (transportOptions) => {
      options.push(transportOptions);
      return {
        close: () => {
          closed += 1;
        },
        sendMail: (message) => {
          messages.push(message);
          return new Promise<SMTPSentMessageInfo>((resolve, reject) => {
            resolveSend = resolve;
            rejectSend = reject;
            assert.ok(transportOptions.getSocket);
            transportOptions.getSocket(transportOptions, (error, socketOptions) => {
              if (error) reject(error);
              else {
                handedOff += 1;
                assert.ok(socketOptions);
                assert.equal(socketOptions.connection, socket);
                assert.equal(socketOptions.secured, true);
              }
            });
          });
        },
      };
    },
  };
  return {
    dependencies,
    options,
    messages,
    connections,
    dnsRequests,
    socket,
    state: () => ({ cancelled, closed, handedOff }),
    resolveDns: (addresses = ['203.0.113.20']) => {
      assert.ok(dnsCallback);
      dnsCallback(null, addresses);
    },
    rejectDns: (error: NodeJS.ErrnoException) => {
      assert.ok(dnsCallback);
      dnsCallback(error, []);
    },
    connectSecurely: () => socket.emit('secureConnect'),
    accept: (accepted = [recipient], rejected: string[] = []) => {
      assert.ok(resolveSend);
      resolveSend({
        accepted,
        rejected,
        ehlo: [],
        envelopeTime: 1,
        messageTime: 1,
        messageSize: 400,
        response: '250 private-provider-response',
        envelope: { from: config.username, to: [recipient] },
        messageId: 'private-provider-id',
      });
    },
    reject: (error: Error) => {
      assert.ok(rejectSend);
      rejectSend(error);
    },
  };
};

const assertSanitized = (error: unknown, expected: string): boolean => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, expected);
  assert.equal(error.cause, undefined);
  const serialized = `${error.stack}\n${JSON.stringify(error)}`;
  for (const privateValue of [config.password, config.username, recipient, token, reset.userId]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  return true;
};

test('SMTP reset mail uses one explicit recipient and a fragment-only link on the configured origin', async () => {
  const harness = createHarness();
  const delivery = new SmtpAuthTokenDelivery(config, harness.dependencies);
  const pending = delivery.sendPasswordReset(reset);
  harness.resolveDns();
  harness.connectSecurely();
  harness.accept();
  await pending;

  assert.equal(harness.messages.length, 1);
  const mail = harness.messages[0];
  assert.ok(mail);
  assert.deepEqual(mail.from, { name: 'Kinetra', address: config.username });
  assert.deepEqual(mail.to, [{ name: '', address: recipient }]);
  assert.deepEqual(mail.envelope, { from: config.username, to: [recipient] });
  assert.equal(mail.cc, undefined);
  assert.equal(mail.bcc, undefined);
  assert.equal(mail.attachments, undefined);
  assert.equal(mail.html, undefined);
  assert.equal(typeof mail.text, 'string');
  const url = new URL(String(mail.text).split('\n\n')[1] ?? '');
  assert.equal(url.origin, config.appOrigin);
  assert.equal(url.pathname, '/auth/reset-password');
  assert.equal(url.search, '');
  assert.equal(url.hash, `#token=${token}`);
  assert.equal(String(mail.text).includes(reset.userId), false);
  assert.equal(String(mail.text).includes(config.password), false);
  assert.equal(mail.disableFileAccess, true);
  assert.equal(mail.disableUrlAccess, true);
  assert.deepEqual(harness.state(), { cancelled: 1, closed: 1, handedOff: 1 });
  assert.equal(harness.socket.destroyCount, 1);
});

test('Gmail verification uses its fixed SMTP host, verified TLS and the email-verification fragment', async () => {
  const harness = createHarness();
  const delivery = new SmtpAuthTokenDelivery(
    { ...config, service: 'gmail', username: 'kinetra.owner@gmail.com' },
    harness.dependencies,
  );
  const pending = delivery.sendEmailVerification({ ...reset, email: recipient });
  harness.resolveDns();
  harness.connectSecurely();
  harness.accept();
  await pending;
  assert.deepEqual(harness.dnsRequests, ['smtp.gmail.com']);
  assert.deepEqual(harness.connections, [
    {
      host: '203.0.113.20',
      port: 465,
      servername: 'smtp.gmail.com',
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
  ]);
  const options = harness.options[0];
  assert.ok(options);
  assert.equal(options.host, 'smtp.gmail.com');
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.equal(options.forceAuth, true);
  assert.equal(options.pool, false);
  assert.equal(options.maxRecipients, 1);
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
  assert.equal(options.transactionLog, false);
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
  for (const timeout of [
    'dnsTimeout',
    'connectionTimeout',
    'greetingTimeout',
    'socketTimeout',
  ] as const) {
    assert.equal(options[timeout], config.timeoutMs);
  }
  const url = new URL(String(harness.messages[0]?.text).split('\n\n')[1] ?? '');
  assert.equal(url.pathname, '/auth/verify-email');
  assert.equal(url.search, '');
  assert.equal(url.hash, `#token=${token}`);
});

test('phone delivery, recipient/header injection and malformed tokens are rejected before any transport exists', async () => {
  const harness = createHarness();
  const delivery = new SmtpAuthTokenDelivery(config, harness.dependencies);
  await assert.rejects(
    delivery.sendPasswordReset({ ...reset, destinationType: 'phone', destination: '+79990000000' }),
    /supports email recipients only/u,
  );
  for (const destination of [
    `${recipient}\r\nBcc: attacker@example.com`,
    `${recipient},attacker@example.com`,
    `${recipient};attacker@example.com`,
    `Someone <${recipient}>`,
    `group:${recipient};`,
    ` ${recipient}`,
    'name@localhost',
    'name..other@example.com',
    'name@example.com\u0000',
  ]) {
    await assert.rejects(delivery.sendPasswordReset({ ...reset, destination }), (error) =>
      assertSanitized(error, 'Invalid auth SMTP message.'),
    );
  }
  for (const badToken of ['', 'short', `${token}&next=https://attacker.example`, `${token}\r\n`]) {
    await assert.rejects(delivery.sendPasswordReset({ ...reset, token: badToken }), (error) =>
      assertSanitized(error, 'Invalid auth SMTP message.'),
    );
  }
  await assert.rejects(delivery.sendPasswordReset({ ...reset, expiresAt: new Date('invalid') }));
  assert.equal(harness.options.length, 0);
  assert.equal(harness.connections.length, 0);
});

test('SMTP configuration rejects arbitrary providers, injection and noncanonical auth-link origins', () => {
  const configurations = [
    { service: 'other' },
    { username: `${config.username}\r\nBcc: attacker@example.com` },
    { password: 'short' },
    { password: `${config.password}\n` },
    { appOrigin: 'http://kinetra.example' },
    { appOrigin: 'https://kinetra.example/' },
    { appOrigin: 'https://user:private@kinetra.example' },
    { appOrigin: 'https://kinetra.example/path' },
    { appOrigin: 'https://kinetra.example?token=private' },
    { appOrigin: 'https://kinetra.example#private' },
    { appOrigin: 'https://kinetra.example\n' },
    { timeoutMs: 0 },
    { timeoutMs: 999 },
    { timeoutMs: 30_001 },
    { timeoutMs: Number.NaN },
  ];
  for (const invalid of configurations) {
    assert.throws(
      () => new SmtpAuthTokenDelivery({ ...config, ...invalid } as SmtpDeliveryConfig),
      (error) => assertSanitized(error, 'Invalid auth SMTP configuration.'),
    );
  }
});

test('provider rejection remains sanitized, closes the socket and never retries an uncertain send', async () => {
  const harness = createHarness();
  const delivery = new SmtpAuthTokenDelivery(config, harness.dependencies);
  const pending = delivery.sendPasswordReset(reset);
  const rejected = assert.rejects(pending, (error) =>
    assertSanitized(error, 'Auth email delivery failed.'),
  );
  harness.resolveDns();
  harness.connectSecurely();
  harness.reject(new Error(`${config.password} ${recipient} ${token}`, { cause: config.username }));
  await rejected;
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.connections.length, 1);
  assert.equal(harness.socket.destroyed, true);
  assert.deepEqual(harness.state(), { cancelled: 1, closed: 1, handedOff: 1 });
});

test('certificate rejection cannot hand a socket to SMTP or leak TLS provider errors', async () => {
  const harness = createHarness();
  const delivery = new SmtpAuthTokenDelivery(config, harness.dependencies);
  const pending = delivery.sendPasswordReset(reset);
  const rejected = assert.rejects(pending, /Auth email delivery failed\./u);
  harness.resolveDns();
  harness.socket.authorized = false;
  harness.connectSecurely();
  await rejected;
  assert.equal(harness.state().handedOff, 0);
  assert.equal(harness.socket.destroyed, true);
});

test('DNS failure is redacted and does not create a connection', async () => {
  const harness = createHarness();
  const delivery = new SmtpAuthTokenDelivery(config, harness.dependencies);
  const pending = delivery.sendPasswordReset(reset);
  const rejected = assert.rejects(pending, (error) =>
    assertSanitized(error, 'Auth email delivery failed.'),
  );
  harness.rejectDns(new Error(`${config.password} ${token}`));
  await rejected;
  assert.equal(harness.connections.length, 0);
  assert.equal(harness.state().cancelled, 1);
});

test('the total deadline cancels pending DNS and ignores its late callback', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = createHarness();
  const delivery = new SmtpAuthTokenDelivery(config, harness.dependencies);
  const pending = delivery.sendPasswordReset(reset);
  const rejected = assert.rejects(pending, (error) =>
    assertSanitized(error, 'Auth email delivery timed out.'),
  );
  context.mock.timers.tick(config.timeoutMs);
  await rejected;
  assert.equal(harness.state().cancelled, 1);
  harness.resolveDns();
  await Promise.resolve();
  assert.equal(harness.connections.length, 0);
  assert.equal(harness.state().handedOff, 0);
  assert.equal(harness.messages.length, 1);
});

test('the deadline destroys an active TLS handshake and does not resume on late secureConnect', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = createHarness();
  const delivery = new SmtpAuthTokenDelivery(config, harness.dependencies);
  const pending = delivery.sendPasswordReset(reset);
  const rejected = assert.rejects(pending, /Auth email delivery timed out\./u);
  harness.resolveDns();
  context.mock.timers.tick(config.timeoutMs);
  await rejected;
  harness.connectSecurely();
  await Promise.resolve();
  assert.equal(harness.socket.destroyCount, 1);
  assert.equal(harness.state().handedOff, 0);
  assert.equal(harness.messages.length, 1);
});

test('the total deadline forcibly closes SMTP even when its send promise never settles', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const harness = createHarness();
  const delivery = new SmtpAuthTokenDelivery(config, harness.dependencies);
  const pending = delivery.sendPasswordReset(reset);
  const rejected = assert.rejects(pending, /Auth email delivery timed out\./u);
  harness.resolveDns();
  harness.connectSecurely();
  context.mock.timers.tick(config.timeoutMs);
  await rejected;
  assert.equal(harness.socket.destroyed, true);
  assert.deepEqual(harness.state(), { cancelled: 1, closed: 1, handedOff: 1 });
  harness.accept();
  await Promise.resolve();
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.socket.destroyCount, 1);
});

test('partial, wrong-recipient or empty SMTP acceptance is a failure', async () => {
  for (const result of [
    { accepted: [], rejected: [recipient] },
    { accepted: [recipient], rejected: [recipient] },
    { accepted: ['someone@example.com'], rejected: [] },
    { accepted: [recipient, 'someone@example.com'], rejected: [] },
  ]) {
    const harness = createHarness();
    const pending = new SmtpAuthTokenDelivery(config, harness.dependencies).sendPasswordReset(
      reset,
    );
    const rejected = assert.rejects(pending, /Auth email delivery failed\./u);
    harness.resolveDns();
    harness.connectSecurely();
    harness.accept(result.accepted, result.rejected);
    await rejected;
    assert.equal(harness.socket.destroyed, true);
  }
});

test('synchronous transport failures are sanitized without logging credentials', async (context) => {
  const logs: unknown[][] = [];
  context.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  context.mock.method(console, 'info', (...args: unknown[]) => logs.push(args));
  context.mock.method(console, 'debug', (...args: unknown[]) => logs.push(args));
  const delivery = new SmtpAuthTokenDelivery(config, {
    createTransport: () => {
      throw new Error(`${config.password} ${recipient} ${token}`);
    },
  });
  await assert.rejects(delivery.sendPasswordReset(reset), (error) =>
    assertSanitized(error, 'Auth email delivery failed.'),
  );
  assert.deepEqual(logs, []);
});

test('the real Nodemailer SMTP transport sends through the owned socket without network access', async () => {
  class OfflineSmtpSocket extends Duplex {
    public readonly authorized = true;
    public readonly commands: string[] = [];
    public mail = '';
    private dataMode = false;
    private input = '';

    public setTimeout(): this {
      return this;
    }

    public override _read(): void {
      // The simulated SMTP peer pushes responses after each command.
    }

    public override _write(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): void {
      this.input += chunk.toString('utf8');
      if (this.dataMode) {
        const end = this.input.indexOf('\r\n.\r\n');
        if (end >= 0) {
          this.mail = this.input.slice(0, end);
          this.input = this.input.slice(end + 5);
          queueMicrotask(() => this.push('250 message accepted\r\n'));
        }
      } else {
        const end = this.input.indexOf('\r\n');
        if (end >= 0) {
          const command = this.input.slice(0, end);
          this.input = this.input.slice(end + 2);
          this.commands.push(command);
          let response: string;
          if (command.startsWith('EHLO ')) response = '250-offline.example\r\n250 AUTH PLAIN\r\n';
          else if (command.startsWith('AUTH PLAIN ')) response = '235 authenticated\r\n';
          else if (command.startsWith('MAIL FROM:') || command.startsWith('RCPT TO:')) {
            response = '250 accepted\r\n';
          } else if (command === 'DATA') {
            this.dataMode = true;
            response = '354 send message\r\n';
          } else {
            callback(new Error('Unexpected offline SMTP command.'));
            return;
          }
          queueMicrotask(() => this.push(response));
        }
      }
      callback();
    }
  }

  const socket = new OfflineSmtpSocket();
  let cancelled = 0;
  const delivery = new SmtpAuthTokenDelivery(config, {
    createResolver: () => ({
      cancel: () => {
        cancelled += 1;
      },
      resolve4: (host, callback) => {
        assert.equal(host, 'smtp.yandex.ru');
        queueMicrotask(() => callback(null, ['203.0.113.20']));
      },
    }),
    connect: (options) => {
      assert.equal(options.servername, 'smtp.yandex.ru');
      assert.equal(options.rejectUnauthorized, true);
      queueMicrotask(() => {
        socket.emit('secureConnect');
        setImmediate(() => socket.push('220 offline.example SMTP\r\n'));
      });
      return socket as unknown as TLSSocket;
    },
  });
  await delivery.sendPasswordReset(reset);
  assert.equal(socket.destroyed, true);
  assert.equal(cancelled, 1);
  assert.deepEqual(
    socket.commands.filter((command) => command.startsWith('RCPT TO:')),
    [`RCPT TO:<${recipient}>`],
  );
  assert.equal(socket.commands.filter((command) => command === 'DATA').length, 1);
  assert.equal(
    socket.commands.some((command) => command === `MAIL FROM:<${config.username}>`),
    true,
  );
  const [headers = '', body = ''] = socket.mail.split('\r\n\r\n');
  const decodedMail = /Content-Transfer-Encoding: base64/iu.test(headers)
    ? Buffer.from(body.replace(/\s/gu, ''), 'base64').toString('utf8')
    : body.replace(/=\r\n/gu, '').replace(/=3D/giu, '=');
  assert.equal(
    decodedMail.includes(`${config.appOrigin}/auth/reset-password#token=${token}`),
    true,
  );
  assert.equal(decodedMail.includes(`/auth/reset-password?token=${token}`), false);
  assert.equal(decodedMail.includes(config.password), false);
});
