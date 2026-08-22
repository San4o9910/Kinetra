import type {
  PushPublicKeyResponse,
  PushSubscriptionRequest,
  PushSubscriptionResponse,
  PushUnsubscribeRequest,
} from '@kinetra/shared';

import { deletePushSubscription, getPushPublicKey, registerPushSubscription } from '../lib/api';
import {
  getExistingServiceWorkerRegistration,
  getReadyServiceWorkerRegistration,
} from './registerServiceWorker';

export type PushPermission = NotificationPermission | 'unsupported';
export type PushBackendRegistrationStatus =
  'unknown' | 'registering' | 'registered' | 'not_registered' | 'error';

export type PushNotificationErrorCode =
  | 'PUSH_UNSUPPORTED'
  | 'PUSH_PERMISSION_DENIED'
  | 'PUSH_PERMISSION_DISMISSED'
  | 'PUSH_PERMISSION_FAILED'
  | 'PUSH_SUBSCRIPTION_INVALID'
  | 'PUSH_BACKEND_REGISTRATION_FAILED'
  | 'PUSH_BROWSER_UNSUBSCRIBE_FAILED';

export class PushNotificationError extends Error {
  public constructor(
    public readonly code: PushNotificationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PushNotificationError';
  }
}

export interface PushNotificationsRuntime {
  readonly isSecureContext: () => boolean;
  readonly hasNotificationApi: () => boolean;
  readonly hasServiceWorkerApi: () => boolean;
  readonly hasPushManagerApi: () => boolean;
  readonly getPermission: () => NotificationPermission;
  readonly requestPermission: () => Promise<NotificationPermission>;
  readonly getExistingRegistration: () => Promise<ServiceWorkerRegistration | null>;
  readonly getReadyRegistration: () => Promise<ServiceWorkerRegistration>;
  readonly getPublicKey: () => Promise<PushPublicKeyResponse>;
  readonly registerSubscription: (
    request: PushSubscriptionRequest,
  ) => Promise<PushSubscriptionResponse>;
  readonly deleteSubscription: (request: PushUnsubscribeRequest) => Promise<void>;
  readonly decodeApplicationServerKey: (publicKey: string) => Uint8Array<ArrayBuffer>;
}

export interface PushNotifications {
  readonly isPushSupported: () => boolean;
  readonly getPushPermission: () => PushPermission;
  readonly getExistingPushSubscription: () => Promise<PushSubscription | null>;
  readonly subscribeToPush: () => Promise<PushSubscription>;
  readonly unsubscribeFromPush: () => Promise<void>;
  readonly bestEffortUnsubscribeFromPush: () => Promise<void>;
  readonly unsubscribeBrowserOnly: () => Promise<void>;
}

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

export const applicationServerKeyFromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const publicKey = value.trim();

  if (
    publicKey.length < 16 ||
    publicKey.length > 256 ||
    !base64UrlPattern.test(publicKey) ||
    typeof atob !== 'function'
  ) {
    throw new PushNotificationError(
      'PUSH_SUBSCRIPTION_INVALID',
      'Публичный ключ push-уведомлений имеет неверный формат.',
    );
  }

  const base64 = publicKey.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch (error) {
    throw new PushNotificationError(
      'PUSH_SUBSCRIPTION_INVALID',
      'Публичный ключ push-уведомлений имеет неверный формат.',
      { cause: error },
    );
  }
};

const requestFromBrowserSubscription = (
  subscription: PushSubscription,
): PushSubscriptionRequest => {
  const serialized = subscription.toJSON();
  const endpoint = serialized.endpoint ?? subscription.endpoint;
  const p256dh = serialized.keys?.['p256dh'];
  const auth = serialized.keys?.['auth'];

  if (
    typeof endpoint !== 'string' ||
    endpoint.length === 0 ||
    typeof p256dh !== 'string' ||
    p256dh.length === 0 ||
    typeof auth !== 'string' ||
    auth.length === 0
  ) {
    throw new PushNotificationError(
      'PUSH_SUBSCRIPTION_INVALID',
      'Браузер вернул неполную push-подписку. Повторите попытку.',
    );
  }

  return {
    endpoint,
    keys: { p256dh, auth },
    expirationTime: serialized.expirationTime ?? subscription.expirationTime ?? null,
  };
};

const defaultRuntime: PushNotificationsRuntime = {
  isSecureContext: () => typeof window !== 'undefined' && window.isSecureContext,
  hasNotificationApi: () => typeof Notification !== 'undefined',
  hasServiceWorkerApi: () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  hasPushManagerApi: () => typeof window !== 'undefined' && 'PushManager' in window,
  getPermission: () => Notification.permission,
  requestPermission: () => Notification.requestPermission(),
  getExistingRegistration: getExistingServiceWorkerRegistration,
  getReadyRegistration: getReadyServiceWorkerRegistration,
  getPublicKey: getPushPublicKey,
  registerSubscription: registerPushSubscription,
  deleteSubscription: deletePushSubscription,
  decodeApplicationServerKey: applicationServerKeyFromBase64Url,
};

export const createPushNotifications = (
  runtime: PushNotificationsRuntime = defaultRuntime,
): PushNotifications => {
  const isPushSupported = (): boolean =>
    runtime.isSecureContext() &&
    runtime.hasNotificationApi() &&
    runtime.hasServiceWorkerApi() &&
    runtime.hasPushManagerApi();

  const getPushPermission = (): PushPermission =>
    isPushSupported() ? runtime.getPermission() : 'unsupported';

  const getExistingPushSubscription = async (): Promise<PushSubscription | null> => {
    if (!isPushSupported()) {
      return null;
    }

    const registration = await runtime.getExistingRegistration();
    return registration === null ? null : registration.pushManager.getSubscription();
  };

  const subscribeToPush = async (): Promise<PushSubscription> => {
    if (!isPushSupported()) {
      throw new PushNotificationError(
        'PUSH_UNSUPPORTED',
        'Push-уведомления недоступны в этом браузере или режиме.',
      );
    }

    let permission = runtime.getPermission();

    if (permission === 'default') {
      try {
        permission = await runtime.requestPermission();
      } catch (error) {
        throw new PushNotificationError(
          'PUSH_PERMISSION_FAILED',
          'Браузер не смог запросить разрешение на уведомления.',
          { cause: error },
        );
      }
    }

    if (permission === 'denied') {
      throw new PushNotificationError(
        'PUSH_PERMISSION_DENIED',
        'Уведомления заблокированы. Разрешите их в настройках браузера.',
      );
    }

    if (permission !== 'granted') {
      throw new PushNotificationError(
        'PUSH_PERMISSION_DISMISSED',
        'Разрешение на уведомления не было предоставлено.',
      );
    }

    const registration = await runtime.getReadyRegistration();
    let subscription = await registration.pushManager.getSubscription();

    if (subscription === null) {
      const publicKey = await runtime.getPublicKey();
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: runtime.decodeApplicationServerKey(publicKey.public_key),
      });
    }

    const response = await runtime.registerSubscription(
      requestFromBrowserSubscription(subscription),
    );

    if (response.subscribed !== true) {
      throw new PushNotificationError(
        'PUSH_BACKEND_REGISTRATION_FAILED',
        'Сервер не подтвердил push-подписку. Повторите попытку.',
      );
    }

    return subscription;
  };

  const unsubscribeFromPush = async (): Promise<void> => {
    const subscription = await getExistingPushSubscription();

    if (subscription === null) {
      return;
    }

    let backendError: unknown = null;

    try {
      await runtime.deleteSubscription({ endpoint: subscription.endpoint });
    } catch (error) {
      backendError = error;
    }

    let removed = false;

    try {
      removed = await subscription.unsubscribe();
    } catch (error) {
      throw new PushNotificationError(
        'PUSH_BROWSER_UNSUBSCRIBE_FAILED',
        'Браузер не смог удалить push-подписку. Повторите попытку.',
        { cause: error },
      );
    }

    if (!removed) {
      throw new PushNotificationError(
        'PUSH_BROWSER_UNSUBSCRIBE_FAILED',
        'Браузер не смог удалить push-подписку. Повторите попытку.',
      );
    }

    if (backendError !== null) {
      throw backendError;
    }
  };

  const bestEffortUnsubscribeFromPush = async (): Promise<void> => {
    let subscription: PushSubscription | null = null;

    try {
      subscription = await getExistingPushSubscription();
    } catch {
      return;
    }

    if (subscription === null) {
      return;
    }

    await Promise.allSettled([
      Promise.resolve().then(() => runtime.deleteSubscription({ endpoint: subscription.endpoint })),
      Promise.resolve().then(() => subscription.unsubscribe()),
    ]);
  };

  const unsubscribeBrowserOnly = async (): Promise<void> => {
    const subscription = await getExistingPushSubscription();

    if (subscription === null) {
      return;
    }

    const removed = await subscription.unsubscribe();

    if (!removed) {
      throw new PushNotificationError(
        'PUSH_BROWSER_UNSUBSCRIBE_FAILED',
        'Браузер не смог удалить push-подписку.',
      );
    }
  };

  return {
    isPushSupported,
    getPushPermission,
    getExistingPushSubscription,
    subscribeToPush,
    unsubscribeFromPush,
    bestEffortUnsubscribeFromPush,
    unsubscribeBrowserOnly,
  };
};

const pushNotifications = createPushNotifications();

export const isPushSupported = (): boolean => pushNotifications.isPushSupported();
export const getPushPermission = (): PushPermission => pushNotifications.getPushPermission();
export const getExistingPushSubscription = (): Promise<PushSubscription | null> =>
  pushNotifications.getExistingPushSubscription();
export const subscribeToPush = (): Promise<PushSubscription> => pushNotifications.subscribeToPush();
export const unsubscribeFromPush = (): Promise<void> => pushNotifications.unsubscribeFromPush();
export const bestEffortUnsubscribeFromPush = (): Promise<void> =>
  pushNotifications.bestEffortUnsubscribeFromPush();
export const unsubscribeBrowserOnly = (): Promise<void> =>
  pushNotifications.unsubscribeBrowserOnly();
