import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PushNotificationError,
  applicationServerKeyFromBase64Url,
  createPushNotifications,
  type PushNotificationsRuntime,
} from '../src/pwa/pushNotifications.js';

const endpoint = 'https://push.example/subscriptions/device-1';

interface PushFixture {
  readonly runtime: PushNotificationsRuntime;
  readonly calls: string[];
  readonly subscription: PushSubscription;
  setPermission(permission: NotificationPermission): void;
  setExistingSubscription(subscription: PushSubscription | null): void;
  failBackendRegistration(): void;
  failBackendDelete(): void;
}

const createSubscription = (calls: string[], unsubscribeResult = true): PushSubscription =>
  ({
    endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true },
    getKey: () => null,
    toJSON: () => ({
      endpoint,
      expirationTime: null,
      keys: { p256dh: 'browser-p256dh', auth: 'browser-auth' },
    }),
    unsubscribe: async () => {
      calls.push('browser:unsubscribe');
      return unsubscribeResult;
    },
  }) as PushSubscription;

const createFixture = (): PushFixture => {
  const calls: string[] = [];
  let permission: NotificationPermission = 'default';
  let existingSubscription: PushSubscription | null = null;
  let rejectBackendRegistration = false;
  let rejectBackendDelete = false;
  const subscription = createSubscription(calls);
  const registration = {
    pushManager: {
      getSubscription: async () => {
        calls.push('browser:get-subscription');
        return existingSubscription;
      },
      subscribe: async (options: PushSubscriptionOptionsInit) => {
        calls.push('browser:subscribe');
        assert.equal(options.userVisibleOnly, true);
        assert.deepEqual(options.applicationServerKey, new Uint8Array([1, 2, 3]));
        existingSubscription = subscription;
        return subscription;
      },
    },
  } as ServiceWorkerRegistration;
  const runtime: PushNotificationsRuntime = {
    isSecureContext: () => true,
    hasNotificationApi: () => true,
    hasServiceWorkerApi: () => true,
    hasPushManagerApi: () => true,
    getPermission: () => permission,
    requestPermission: async () => {
      calls.push('permission:request');
      permission = 'granted';
      return permission;
    },
    getExistingRegistration: async () => {
      calls.push('service-worker:existing');
      return registration;
    },
    getReadyRegistration: async () => {
      calls.push('service-worker:ready');
      return registration;
    },
    getPublicKey: async () => {
      calls.push('api:public-key');
      return { public_key: 'test-public-key' };
    },
    registerSubscription: async (request) => {
      calls.push('api:register');
      assert.deepEqual(request, {
        endpoint,
        keys: { p256dh: 'browser-p256dh', auth: 'browser-auth' },
        expirationTime: null,
      });

      if (rejectBackendRegistration) {
        throw new Error('Backend unavailable.');
      }

      return { subscribed: true };
    },
    deleteSubscription: async (request) => {
      calls.push('api:delete');
      assert.deepEqual(request, { endpoint });

      if (rejectBackendDelete) {
        throw new Error('Backend unavailable.');
      }
    },
    decodeApplicationServerKey: (publicKey) => {
      calls.push('vapid:decode');
      assert.equal(publicKey, 'test-public-key');
      return new Uint8Array([1, 2, 3]);
    },
  };

  return {
    runtime,
    calls,
    subscription,
    setPermission: (nextPermission) => {
      permission = nextPermission;
    },
    setExistingSubscription: (nextSubscription) => {
      existingSubscription = nextSubscription;
    },
    failBackendRegistration: () => {
      rejectBackendRegistration = true;
    },
    failBackendDelete: () => {
      rejectBackendDelete = true;
    },
  };
};

test('T13 hydration checks an existing browser subscription without prompting or fetching VAPID', async () => {
  const fixture = createFixture();
  const push = createPushNotifications(fixture.runtime);

  assert.equal(push.isPushSupported(), true);
  assert.equal(push.getPushPermission(), 'default');
  assert.equal(await push.getExistingPushSubscription(), null);
  assert.deepEqual(fixture.calls, ['service-worker:existing', 'browser:get-subscription']);
  assert.equal(fixture.calls.includes('permission:request'), false);
  assert.equal(fixture.calls.includes('api:public-key'), false);
  assert.equal(fixture.calls.includes('api:register'), false);
});

test('T13 explicit subscribe requests permission first, creates a browser subscription and upserts it', async () => {
  const fixture = createFixture();
  const push = createPushNotifications(fixture.runtime);

  assert.equal(await push.subscribeToPush(), fixture.subscription);
  assert.deepEqual(fixture.calls, [
    'permission:request',
    'service-worker:ready',
    'browser:get-subscription',
    'api:public-key',
    'vapid:decode',
    'browser:subscribe',
    'api:register',
  ]);
});

test('T13 an existing browser subscription is upserted without a new prompt or public-key request', async () => {
  const fixture = createFixture();
  fixture.setPermission('granted');
  fixture.setExistingSubscription(fixture.subscription);
  const push = createPushNotifications(fixture.runtime);

  assert.equal(await push.subscribeToPush(), fixture.subscription);
  assert.deepEqual(fixture.calls, [
    'service-worker:ready',
    'browser:get-subscription',
    'api:register',
  ]);
});

test('T13 denied permission cannot loop a prompt or access push configuration', async () => {
  const fixture = createFixture();
  fixture.setPermission('denied');
  const push = createPushNotifications(fixture.runtime);

  await assert.rejects(
    push.subscribeToPush(),
    (error: unknown) =>
      error instanceof PushNotificationError && error.code === 'PUSH_PERMISSION_DENIED',
  );
  assert.deepEqual(fixture.calls, []);
});

test('T13 unsupported environments remain read-only and do not touch browser or backend APIs', async () => {
  const fixture = createFixture();
  const push = createPushNotifications({
    ...fixture.runtime,
    isSecureContext: () => false,
  });

  assert.equal(push.isPushSupported(), false);
  assert.equal(push.getPushPermission(), 'unsupported');
  assert.equal(await push.getExistingPushSubscription(), null);
  await assert.rejects(
    push.subscribeToPush(),
    (error: unknown) => error instanceof PushNotificationError && error.code === 'PUSH_UNSUPPORTED',
  );
  assert.deepEqual(fixture.calls, []);
});

test('T13 backend registration failure never removes or reports away the browser subscription', async () => {
  const fixture = createFixture();
  fixture.setPermission('granted');
  fixture.failBackendRegistration();
  const push = createPushNotifications(fixture.runtime);

  await assert.rejects(push.subscribeToPush(), /Backend unavailable/u);
  assert.equal(await push.getExistingPushSubscription(), fixture.subscription);
  assert.equal(fixture.calls.includes('browser:unsubscribe'), false);
});

test('T13 explicit and best-effort unsubscribe preserve their different failure semantics', async () => {
  const explicitFixture = createFixture();
  explicitFixture.setPermission('granted');
  explicitFixture.setExistingSubscription(explicitFixture.subscription);
  const explicitPush = createPushNotifications(explicitFixture.runtime);

  await explicitPush.unsubscribeFromPush();
  assert.deepEqual(explicitFixture.calls, [
    'service-worker:existing',
    'browser:get-subscription',
    'api:delete',
    'browser:unsubscribe',
  ]);

  const explicitBackendFailureFixture = createFixture();
  explicitBackendFailureFixture.setPermission('granted');
  explicitBackendFailureFixture.setExistingSubscription(explicitBackendFailureFixture.subscription);
  explicitBackendFailureFixture.failBackendDelete();
  const explicitBackendFailurePush = createPushNotifications(explicitBackendFailureFixture.runtime);

  await assert.rejects(explicitBackendFailurePush.unsubscribeFromPush(), /Backend unavailable/u);
  assert.deepEqual(explicitBackendFailureFixture.calls, [
    'service-worker:existing',
    'browser:get-subscription',
    'api:delete',
    'browser:unsubscribe',
  ]);

  const logoutFixture = createFixture();
  logoutFixture.setPermission('granted');
  logoutFixture.setExistingSubscription(logoutFixture.subscription);
  logoutFixture.failBackendDelete();
  const logoutPush = createPushNotifications(logoutFixture.runtime);

  await logoutPush.bestEffortUnsubscribeFromPush();
  assert.deepEqual(logoutFixture.calls, [
    'service-worker:existing',
    'browser:get-subscription',
    'api:delete',
    'browser:unsubscribe',
  ]);
});

test('T13 base64url VAPID conversion is bounded and deterministic', () => {
  assert.deepEqual(
    [...applicationServerKeyFromBase64Url('AQIDBAUGBwgJCgsMDQ4PEA')],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  );
  assert.throws(
    () => applicationServerKeyFromBase64Url('not valid base64url'),
    (error: unknown) =>
      error instanceof PushNotificationError && error.code === 'PUSH_SUBSCRIPTION_INVALID',
  );

  console.log('KINETRA_T13_PERMISSION_LIFECYCLE=PASS');
});
