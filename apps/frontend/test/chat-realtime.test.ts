import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Server as SocketServer } from 'socket.io';

import { ChatRealtimeSocketClient, classifyChatTokenFailure } from '../src/realtime/socket.js';

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the realtime client state.');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('T12 socket token failure classification preserves auth lifecycle boundaries', () => {
  assert.equal(
    classifyChatTokenFailure({ code: 'AUTH_SESSION_CHANGED', kind: 'auth' }),
    'terminal',
  );
  assert.equal(
    classifyChatTokenFailure({ code: 'AUTH_SESSION_CHANGED', kind: 'request' }),
    'stale',
  );
  assert.equal(classifyChatTokenFailure({ code: 'NO_SESSION', kind: 'auth' }), 'terminal');
  assert.equal(classifyChatTokenFailure({ code: 'NETWORK_ERROR', kind: 'network' }), 'transient');
  assert.equal(classifyChatTokenFailure({ code: 'REQUEST_FAILED', kind: 'server' }), 'transient');
});

test('T12 initial transient token failures retry to connected without invalidating the session', async () => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, { transports: ['websocket'] });
  let acceptedConnections = 0;
  socketServer.of('/chat').on('connection', () => {
    acceptedConnections += 1;
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const url = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    for (const failure of [
      { code: 'NETWORK_ERROR', kind: 'network' },
      { code: 'REQUEST_FAILED', kind: 'server' },
    ]) {
      let tokenCalls = 0;
      let invalidations = 0;
      const client = new ChatRealtimeSocketClient({
        url,
        getAccessToken: async () => {
          tokenCalls += 1;
          if (tokenCalls === 1) throw failure;
          return 'fresh-token';
        },
      });
      const unsubscribe = client.subscribe((event) => {
        if (event.type === 'session:invalidated') invalidations += 1;
      });

      try {
        await client.connect();
        await waitFor(() => client.connectionState === 'connected');
        assert.equal(tokenCalls, 2);
        assert.equal(invalidations, 0);
      } finally {
        unsubscribe();
        client.disconnect();
      }
    }

    assert.equal(acceptedConnections, 2);
  } finally {
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  }
});

test('T12 initial terminal and stale token failures never leave an unhandled socket lifecycle', async () => {
  for (const fixture of [
    {
      error: { code: 'AUTH_SESSION_CHANGED', kind: 'auth' },
      expectedInvalidations: 1,
    },
    {
      error: { code: 'AUTH_SESSION_CHANGED', kind: 'request' },
      expectedInvalidations: 0,
    },
  ]) {
    let invalidations = 0;
    const client = new ChatRealtimeSocketClient({
      getAccessToken: async () => {
        throw fixture.error;
      },
    });
    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'session:invalidated') invalidations += 1;
    });

    await client.connect();
    assert.equal(client.connectionState, 'disconnected');
    assert.equal(invalidations, fixture.expectedInvalidations);
    unsubscribe();
    client.disconnect();
  }
});

test('T12 transient refresh failure retries with backoff and recovers without logout', async () => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, { transports: ['websocket'] });
  const namespace = socketServer.of('/chat');
  let acceptedConnections = 0;

  namespace.use((socket, next) => {
    if ((socket.handshake.auth as { accessToken?: unknown }).accessToken === 'fresh-token') {
      next();
      return;
    }

    const error = new Error('expired') as Error & { data?: { code: string } };
    error.data = { code: 'AUTHENTICATION_REQUIRED' };
    next(error);
  });
  namespace.on('connection', () => {
    acceptedConnections += 1;
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const url = `http://127.0.0.1:${(address as { port: number }).port}`;
  let refreshCalls = 0;
  let invalidations = 0;
  const client = new ChatRealtimeSocketClient({
    url,
    getAccessToken: async () => 'expired-token',
    refreshAccessToken: async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        throw { code: 'NETWORK_ERROR', kind: 'network' };
      }
      return 'fresh-token';
    },
  });
  const unsubscribe = client.subscribe((event) => {
    if (event.type === 'session:invalidated') invalidations += 1;
  });

  try {
    await client.connect();
    await waitFor(() => client.connectionState === 'connected');
    assert.equal(refreshCalls, 2);
    assert.equal(invalidations, 0);
    assert.equal(acceptedConnections, 1);
  } finally {
    unsubscribe();
    client.disconnect();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  }
});

test('T12 rejected socket refresh logs out only terminal auth, never a stale request lifecycle', async () => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, { transports: ['websocket'] });
  const namespace = socketServer.of('/chat');
  namespace.use((_socket, next) => {
    const error = new Error('expired') as Error & { data?: { code: string } };
    error.data = { code: 'AUTHENTICATION_REQUIRED' };
    next(error);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const url = `http://127.0.0.1:${(address as { port: number }).port}`;

  try {
    for (const fixture of [
      {
        error: { code: 'AUTH_SESSION_CHANGED', kind: 'auth' },
        expectedInvalidations: 1,
      },
      {
        error: { code: 'AUTH_SESSION_CHANGED', kind: 'request' },
        expectedInvalidations: 0,
      },
    ]) {
      let invalidations = 0;
      let refreshCalls = 0;
      const client = new ChatRealtimeSocketClient({
        url,
        getAccessToken: async () => 'expired-token',
        refreshAccessToken: async () => {
          refreshCalls += 1;
          throw fixture.error;
        },
      });
      const unsubscribe = client.subscribe((event) => {
        if (event.type === 'session:invalidated') invalidations += 1;
      });

      try {
        await client.connect();
        await waitFor(() => refreshCalls === 1 && client.connectionState === 'disconnected');
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(refreshCalls, 1);
        assert.equal(invalidations, fixture.expectedInvalidations);
      } finally {
        unsubscribe();
        client.disconnect();
      }
    }
  } finally {
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  }
});

test('T12 production socket client refreshes once after an expired offline handshake', async () => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, { transports: ['websocket'] });
  const namespace = socketServer.of('/chat');
  let acceptedConnections = 0;

  namespace.use((socket, next) => {
    if ((socket.handshake.auth as { accessToken?: unknown }).accessToken === 'fresh-token') {
      next();
      return;
    }

    const error = new Error('expired') as Error & { data?: { code: string } };
    error.data = { code: 'AUTHENTICATION_REQUIRED' };
    next(error);
  });
  namespace.on('connection', () => {
    acceptedConnections += 1;
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const url = `http://127.0.0.1:${(address as { port: number }).port}`;
  let refreshCalls = 0;
  const states: string[] = [];
  const client = new ChatRealtimeSocketClient({
    url,
    getAccessToken: async () => 'expired-token',
    refreshAccessToken: async () => {
      refreshCalls += 1;
      return 'fresh-token';
    },
  });
  const unsubscribe = client.subscribe((event) => {
    if (event.type === 'connection') states.push(event.state);
  });

  try {
    await client.connect();
    await waitFor(() => client.connectionState === 'connected');
    assert.equal(refreshCalls, 1);
    assert.equal(acceptedConnections, 1);
    assert.ok(states.includes('connecting'));
    assert.ok(states.includes('connected'));
  } finally {
    unsubscribe();
    client.disconnect();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  }
});

test('T12 disposed account-A refresh cannot mutate the reused account-B socket', async () => {
  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer, { transports: ['websocket'] });
  const namespace = socketServer.of('/chat');
  const acceptedTokens: string[] = [];
  let accountBSocket: Parameters<Parameters<typeof namespace.on>[1]>[0] | null = null;
  let currentAccessToken = 'account-a-token';
  let releaseRefresh: (() => void) | null = null;
  let announceRefreshStarted: (() => void) | null = null;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refreshStarted = new Promise<void>((resolve) => {
    announceRefreshStarted = resolve;
  });

  namespace.on('connection', (socket) => {
    const accessToken = String(
      (socket.handshake.auth as { readonly accessToken?: unknown }).accessToken ?? '',
    );
    acceptedTokens.push(accessToken);

    if (accessToken === 'account-a-token') {
      socket.disconnect(true);
    } else if (accessToken === 'account-b-token') {
      accountBSocket = socket;
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const url = `http://127.0.0.1:${(address as { port: number }).port}`;
  const client = new ChatRealtimeSocketClient({
    url,
    getAccessToken: async () => currentAccessToken,
    refreshAccessToken: async () => {
      announceRefreshStarted?.();
      await refreshGate;
      return 'late-account-a-token';
    },
  });

  try {
    await client.connect();
    await refreshStarted;
    client.disconnect();

    currentAccessToken = 'account-b-token';
    await client.connect();
    await waitFor(() => client.connectionState === 'connected' && accountBSocket !== null);
    releaseRefresh?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    accountBSocket?.conn.close();
    await waitFor(() => acceptedTokens.length >= 3 && client.connectionState === 'connected');
    assert.deepEqual(acceptedTokens, ['account-a-token', 'account-b-token', 'account-b-token']);
    assert.equal(client.connectionState, 'connected');
  } finally {
    releaseRefresh?.();
    client.disconnect();
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    if (httpServer.listening) {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  }
});
