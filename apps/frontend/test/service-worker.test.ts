import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';

type ServiceWorkerListener = (event: unknown) => void;

interface NotificationRecord {
  readonly title: string;
  readonly options: NotificationOptions;
}

interface WindowClientFixture {
  readonly url: string;
  readonly focus: () => Promise<void>;
  readonly navigate: (url: string) => Promise<WindowClientFixture | null>;
}

interface ServiceWorkerHarness {
  readonly notifications: NotificationRecord[];
  readonly openedWindows: string[];
  readonly listener: (type: string) => ServiceWorkerListener;
  readonly setWindowClients: (clients: readonly WindowClientFixture[]) => void;
}

const serviceWorkerPath = new URL('../public/service-worker.js', import.meta.url);

const toHostValue = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

const createHarness = async (): Promise<ServiceWorkerHarness> => {
  const source = await readFile(serviceWorkerPath, 'utf8');
  const listeners = new Map<string, ServiceWorkerListener>();
  const notifications: NotificationRecord[] = [];
  const openedWindows: string[] = [];
  let windowClients: readonly WindowClientFixture[] = [];
  const self = {
    location: { origin: 'https://kinetra.app' },
    registration: {
      showNotification: async (title: string, options: NotificationOptions) => {
        notifications.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windowClients,
      openWindow: async (url: string) => {
        openedWindows.push(url);
        return null;
      },
    },
    skipWaiting: async () => undefined,
    addEventListener: (type: string, listener: ServiceWorkerListener) => {
      listeners.set(type, listener);
    },
  };
  const caches = {
    keys: async () => [],
    delete: async () => true,
    match: async () => undefined,
    open: async () => ({
      addAll: async () => undefined,
      put: async () => undefined,
    }),
  };
  const context = createContext({
    self,
    caches,
    fetch: async () => new Response(null, { status: 204 }),
    URL,
    Response,
  });
  new Script(source, { filename: serviceWorkerPath.pathname }).runInContext(context);

  return {
    notifications,
    openedWindows,
    listener: (type) => {
      const listener = listeners.get(type);
      assert.notEqual(listener, undefined, `Service worker listener ${type} was not registered.`);
      return listener as ServiceWorkerListener;
    },
    setWindowClients: (clients) => {
      windowClients = clients;
    },
  };
};

const dispatchPush = async (
  harness: ServiceWorkerHarness,
  data: { readonly json: () => unknown } | null,
): Promise<void> => {
  let pending: Promise<unknown> = Promise.resolve();
  harness.listener('push')({
    data,
    waitUntil: (promise: Promise<unknown>) => {
      pending = promise;
    },
  });
  await pending;
};

const dispatchNotificationClick = async (
  harness: ServiceWorkerHarness,
  data: unknown,
  onClose: () => void,
): Promise<void> => {
  let pending: Promise<unknown> = Promise.resolve();
  harness.listener('notificationclick')({
    notification: { data, close: onClose },
    waitUntil: (promise: Promise<unknown>) => {
      pending = promise;
    },
  });
  await pending;
};

test('T13 service worker shows bounded notifications and sends external URLs to the safe root', async () => {
  const harness = await createHarness();

  await dispatchPush(harness, {
    json: () => ({
      type: 'workout_reminder',
      title: 'Пора двигаться',
      body: 'Сегодня вас ждёт тренировка.',
      url: 'https://evil.example/phishing',
    }),
  });

  assert.equal(harness.notifications.length, 1);
  assert.deepEqual(toHostValue(harness.notifications[0]), {
    title: 'Пора двигаться',
    options: {
      body: 'Сегодня вас ждёт тренировка.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: {
        type: 'workout_reminder',
        url: 'https://kinetra.app/',
      },
    },
  });

  await dispatchPush(harness, {
    json: () => {
      throw new SyntaxError('Malformed payload.');
    },
  });
  assert.deepEqual(toHostValue(harness.notifications[1]), {
    title: 'Kinetra',
    options: {
      body: 'Откройте приложение, чтобы продолжить.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { type: 'generic', url: '/' },
    },
  });
});

test('T13 notification click navigates and focuses an existing same-origin window', async () => {
  const harness = await createHarness();
  const actions: string[] = [];
  const navigatedClient: WindowClientFixture = {
    url: 'https://kinetra.app/progress',
    focus: async () => {
      actions.push('focus:navigated');
    },
    navigate: async () => null,
  };
  const existingClient: WindowClientFixture = {
    url: 'https://kinetra.app/settings',
    focus: async () => {
      actions.push('focus:existing');
    },
    navigate: async (url) => {
      actions.push(`navigate:${url}`);
      return navigatedClient;
    },
  };
  harness.setWindowClients([existingClient]);
  let closed = false;

  await dispatchNotificationClick(
    harness,
    { type: 'weekly_survey_reminder', url: '/progress?source=push#weekly' },
    () => {
      closed = true;
    },
  );

  assert.equal(closed, true);
  assert.deepEqual(actions, ['navigate:https://kinetra.app/progress', 'focus:navigated']);
  assert.deepEqual(harness.openedWindows, []);
});

test('T13 notification click opens a canonical workout deep link when no window exists', async () => {
  const harness = await createHarness();
  harness.setWindowClients([]);
  let closed = false;

  await dispatchNotificationClick(harness, { type: 'workout_reminder', url: '/schedule' }, () => {
    closed = true;
  });

  assert.equal(closed, true);
  assert.deepEqual(harness.openedWindows, ['https://kinetra.app/schedule']);
});

test('T13 malformed or external notification clicks never open an external origin', async () => {
  const harness = await createHarness();
  harness.setWindowClients([]);
  let closed = false;

  await dispatchNotificationClick(
    harness,
    { type: 'weekly_survey_reminder', url: 'javascript:alert(1)' },
    () => {
      closed = true;
    },
  );

  assert.equal(closed, true);
  assert.deepEqual(harness.openedWindows, ['https://kinetra.app/']);
  assert.equal(
    harness.openedWindows.some((url) => !url.startsWith('https://kinetra.app/')),
    false,
  );

  console.log('KINETRA_T13_SERVICE_WORKER=PASS');
});
