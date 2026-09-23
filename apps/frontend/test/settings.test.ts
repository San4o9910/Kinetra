import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  NotificationPreferences,
  SettingsProfileResponse,
  SubscriptionResponse,
} from '@kinetra/shared';
import type {
  PushBackendRegistrationStatus,
  PushPermission,
} from '../src/pwa/pushNotifications.js';

import { TrainerSignOutState } from '../src/App.js';
import { runAccountDeletionLifecycle } from '../src/features/settings/accountLifecycle.js';
import { restartChatRuntime } from '../src/features/chat/runtime.js';
import { SettingsDialogs } from '../src/features/settings/SettingsDialogs.js';
import { SettingsView } from '../src/features/settings/SettingsView.js';
import {
  formatMemberSince,
  formatSubscriptionAmount,
  formatSubscriptionDate,
  notificationTimeOptions,
  SETTINGS_NOTIFICATION_DEBOUNCE_MS,
  subscriptionPresentation,
} from '../src/features/settings/model.js';

const profile: SettingsProfileResponse = {
  email: 'athlete@example.com',
  phone: null,
  created_at: '2026-01-10T10:00:00.000Z',
  onboarding_status: 'active',
  notification_preferences: {
    workout_reminders: true,
    reminder_time: '09:00',
    weekly_survey_reminder: true,
  },
};

const subscription: SubscriptionResponse = {
  status: 'active',
  provider: 'yukassa',
  starts_at: '2026-01-15T00:00:00.000Z',
  expires_at: '2026-02-15T00:00:00.000Z',
  amount: 799,
  currency: 'RUB',
  auto_renew: true,
  days_remaining: 6,
};

const notifications: NotificationPreferences = profile.notification_preferences;

interface PushFixture {
  readonly permission: PushPermission;
  readonly browserSubscribed: boolean;
  readonly backendRegistration: PushBackendRegistrationStatus;
  readonly busy: boolean;
  readonly error: string | null;
}

const defaultPushFixture: PushFixture = {
  permission: 'default',
  browserSubscribed: false,
  backendRegistration: 'unknown',
  busy: false,
  error: null,
};

const renderSettings = (
  fixture: SubscriptionResponse = subscription,
  push: PushFixture = defaultPushFixture,
  chatAvailable = false,
): string =>
  renderToStaticMarkup(
    createElement(SettingsView, {
      profile,
      subscription: fixture,
      notifications,
      notificationSaveStatus: 'idle',
      pushPermission: push.permission,
      pushBrowserSubscribed: push.browserSubscribed,
      pushBackendRegistration: push.backendRegistration,
      pushBusy: push.busy,
      pushError: push.error,
      hasSurvey: true,
      chatAvailable,
      themePreference: 'system',
      resolvedTheme: 'dark',
      supportEmail: 'coach@kinetra.app',
      onClose: () => undefined,
      onOpenChat: () => undefined,
      onNotificationsChange: () => undefined,
      onEnablePush: () => undefined,
      onDisablePush: () => undefined,
      onThemeChange: () => undefined,
      onEditSurvey: () => undefined,
      onOpenLevel: () => undefined,
      onOpenAbout: () => undefined,
      onOpenPayment: () => undefined,
      onOpenRenewalInfo: () => undefined,
      onOpenLogout: () => undefined,
      onOpenDelete: () => undefined,
    }),
  );

test('free beta has its own access notice without inventing a paid subscription', () => {
  const beta = {
    status: 'none',
    provider: null,
    starts_at: null,
    expires_at: null,
    amount: null,
    currency: null,
    auto_renew: null,
    days_remaining: null,
    payments_enabled: false,
    training_access: 'free_beta',
  } satisfies SubscriptionResponse & {
    payments_enabled: false;
    training_access: 'free_beta';
  };
  const markup = renderSettings(beta);
  assert.ok(markup.includes('data-testid="settings-free-beta-access"'));
  assert.ok(markup.includes('Бесплатный тестовый доступ'));
  assert.ok(markup.includes('Тренировки открыты на время тестирования. Оплата не требуется.'));
  assert.ok(markup.includes('data-status="none"'));
  assert.equal(markup.includes('data-testid="settings-renew-subscription"'), false);
  assert.equal(markup.includes('data-testid="settings-cancel-auto-renew"'), false);
  assert.equal(markup.includes('data-testid="settings-subscription-provider"'), false);

  const paidBeta = { ...subscription, payments_enabled: false, training_access: 'free_beta' };
  const paidMarkup = renderSettings(paidBeta);
  assert.ok(paidMarkup.includes('data-testid="settings-free-beta-access"'));
  assert.ok(paidMarkup.includes('Активна до 15 февраля 2026'));
  assert.ok(paidMarkup.includes('799 ₽'));
  assert.ok(paidMarkup.includes('data-testid="settings-cancel-auto-renew"'));

  for (const invalid of [
    { ...beta, payments_enabled: true },
    { ...beta, payments_enabled: undefined },
    { ...beta, training_access: undefined },
  ]) {
    assert.equal(
      renderSettings(invalid).includes('data-testid="settings-free-beta-access"'),
      false,
    );
  }
});

test('disabled checkout hides purchases while retaining subscription status and cancellation', () => {
  for (const status of ['none', 'expired', 'cancelled'] as const) {
    const disabled = { ...subscription, status, payments_enabled: false };
    const markup = renderSettings(disabled);
    const presentation = subscriptionPresentation(disabled);
    assert.ok(markup.includes('Оплата появится позже'));
    assert.ok(markup.includes(`data-status="${status}"`));
    assert.equal(markup.includes('data-testid="settings-renew-subscription"'), false);
    assert.equal(presentation.showRenew, false);
    assert.equal(presentation.primaryActionLabel, null);
  }

  const activeWithDisabledPayments = { ...subscription, payments_enabled: false };
  const active = renderSettings(activeWithDisabledPayments);
  assert.ok(active.includes('data-status="active"'));
  assert.ok(active.includes('Активна до'));
  assert.ok(active.includes('data-testid="settings-cancel-auto-renew"'));
  assert.ok(active.includes('Оплата появится позже'));
  assert.equal(active.includes('data-testid="settings-renew-subscription"'), false);
});

test('T10 settings view renders all six sections and canonical controls', () => {
  const markup = renderSettings();

  for (const section of [
    'subscription',
    'notifications',
    'profile',
    'appearance',
    'support',
    'account',
  ]) {
    assert.ok(markup.includes(`data-testid="settings-${section}-section"`));
  }

  assert.equal((markup.match(/role="switch"/gu) ?? []).length, 2);
  assert.equal((markup.match(/name="kinetra-theme"/gu) ?? []).length, 3);
  assert.equal((markup.match(/<option value="/gu) ?? []).length, 33);
  assert.ok(markup.includes('Системная'));
  assert.ok(markup.includes('Светлая'));
  assert.ok(markup.includes('Тёмная'));
  assert.ok(markup.includes('mailto:coach@kinetra.app'));
  assert.ok(markup.includes('data-testid="edit-survey"'));
  assert.ok(markup.includes('data-testid="logout"'));
  assert.ok(markup.includes('data-testid="settings-delete-account"'));
});

test('T12 settings opens protected trainer chat and uses email only as a controlled fallback', () => {
  const chatMarkup = renderSettings(subscription, defaultPushFixture, true);
  assert.ok(chatMarkup.includes('data-testid="settings-contact-coach"'));
  assert.ok(chatMarkup.includes('Открыть защищённый чат'));
  assert.equal(chatMarkup.includes('mailto:coach@kinetra.app'), false);

  const fallbackMarkup = renderSettings(subscription, defaultPushFixture, false);
  assert.ok(fallbackMarkup.includes('mailto:coach@kinetra.app'));
});

test('subscription card renders provider, amount, expiry and real T11 actions', () => {
  const markup = renderSettings();
  assert.ok(markup.includes('Активна до 15 февраля 2026'));
  assert.ok(markup.includes('ЮKassa'));
  assert.ok(markup.includes('799 ₽'));
  assert.equal(markup.includes('data-testid="settings-renew-subscription"'), false);
  assert.ok(markup.includes('Отменить автопродление'));

  const noneMarkup = renderSettings({
    status: 'none',
    provider: null,
    starts_at: null,
    expires_at: null,
    amount: null,
    currency: null,
    auto_renew: null,
    days_remaining: null,
  });
  assert.ok(noneMarkup.includes('Нет подписки'));
  assert.ok(noneMarkup.includes('Оформить подписку'));
  assert.ok(noneMarkup.includes('data-testid="settings-renew-subscription"'));
  assert.equal(noneMarkup.includes('ЮKassa'), false);

  const expiredMarkup = renderSettings({ ...subscription, status: 'expired', auto_renew: false });
  assert.ok(expiredMarkup.includes('Продлить подписку'));

  const canceledRenewalMarkup = renderSettings({ ...subscription, auto_renew: false });
  assert.ok(canceledRenewalMarkup.includes('Автопродление отключено'));
});

test('settings dialogs expose renewal cancellation and two-stage destructive deletion', () => {
  const renewal = renderToStaticMarkup(
    createElement(SettingsDialogs, {
      activeDialog: 'renewal',
      appVersion: '0.4.0',
      privacyUrl: 'https://kinetra.app/privacy',
      deleteStage: 1,
      deleteConfirmation: '',
      busy: false,
      error: null,
      onClose: () => undefined,
      onContinueDelete: () => undefined,
      onDeleteConfirmationChange: () => undefined,
      onCancelSubscription: () => undefined,
      onLogout: () => undefined,
      onDelete: () => undefined,
    }),
  );
  assert.ok(renewal.includes('Отменить автопродление?'));
  assert.ok(renewal.includes('data-testid="settings-cancel-auto-renew-confirm"'));
  assert.ok(renewal.includes('Новых списаний не будет'));

  const stageOne = renderToStaticMarkup(
    createElement(SettingsDialogs, {
      activeDialog: 'delete',
      appVersion: '0.4.0',
      privacyUrl: 'https://kinetra.app/privacy',
      deleteStage: 1,
      deleteConfirmation: '',
      busy: false,
      error: null,
      onClose: () => undefined,
      onContinueDelete: () => undefined,
      onDeleteConfirmationChange: () => undefined,
      onCancelSubscription: () => undefined,
      onLogout: () => undefined,
      onDelete: () => undefined,
    }),
  );
  assert.ok(stageOne.includes('data-testid="settings-delete-continue"'));
  assert.equal(stageOne.includes('data-testid="settings-delete-confirmation"'), false);

  const stageTwo = renderToStaticMarkup(
    createElement(SettingsDialogs, {
      activeDialog: 'delete',
      appVersion: '0.4.0',
      privacyUrl: 'https://kinetra.app/privacy',
      deleteStage: 2,
      deleteConfirmation: 'DELETE',
      busy: false,
      error: null,
      onClose: () => undefined,
      onContinueDelete: () => undefined,
      onDeleteConfirmationChange: () => undefined,
      onCancelSubscription: () => undefined,
      onLogout: () => undefined,
      onDelete: () => undefined,
    }),
  );
  assert.ok(stageTwo.includes('data-testid="settings-delete-confirmation"'));
  assert.match(stageTwo, /data-testid="settings-delete-confirm"[^>]*>Удалить навсегда/iu);
  assert.ok(stageTwo.includes('data-testid="logout-confirm"'));
  assert.ok(stageTwo.includes('Политика конфиденциальности'));
  assert.ok(stageTwo.includes('Мастерство'));
  assert.ok(stageTwo.includes('Пик'));
});

test('logout failure stays visibly incomplete and exposes an explicit retry', () => {
  const failedSettingsLogout = renderToStaticMarkup(
    createElement(SettingsDialogs, {
      activeDialog: 'logout',
      appVersion: '0.4.0',
      privacyUrl: 'https://kinetra.app/privacy',
      deleteStage: 1,
      deleteConfirmation: '',
      busy: false,
      error: 'Выход не завершен. Сервер не подтвердил отзыв сессии.',
      onClose: () => undefined,
      onContinueDelete: () => undefined,
      onDeleteConfirmationChange: () => undefined,
      onCancelSubscription: () => undefined,
      onLogout: () => undefined,
      onDelete: () => undefined,
    }),
  );
  assert.ok(failedSettingsLogout.includes('Выход не завершен'));
  assert.match(failedSettingsLogout, /data-testid="logout-confirm"[^>]*>Повторить/iu);

  const pendingTrainerLogout = renderToStaticMarkup(
    createElement(TrainerSignOutState, { state: 'pending', onRetry: () => undefined }),
  );
  assert.ok(pendingTrainerLogout.includes('data-testid="trainer-sign-out-pending"'));
  assert.ok(pendingTrainerLogout.includes('Рабочие диалоги временно скрыты'));
  assert.equal(pendingTrainerLogout.includes('Диалоги</h1>'), false);

  const failedTrainerLogout = renderToStaticMarkup(
    createElement(TrainerSignOutState, { state: 'failed', onRetry: () => undefined }),
  );
  assert.ok(failedTrainerLogout.includes('data-testid="trainer-sign-out-failed"'));
  assert.ok(failedTrainerLogout.includes('Выход не завершен'));
  assert.ok(failedTrainerLogout.includes('Вы по-прежнему вошли в аккаунт'));
  assert.ok(failedTrainerLogout.includes('Повторить'));
});

test('settings model fixes date, time, debounce and subscription-state contracts', () => {
  assert.equal(notificationTimeOptions.length, 33);
  assert.equal(notificationTimeOptions[0], '06:00');
  assert.equal(notificationTimeOptions.at(-1), '22:00');
  assert.equal(SETTINGS_NOTIFICATION_DEBOUNCE_MS, 450);
  assert.equal(formatMemberSince(profile.created_at), 'С нами с января 2026');
  assert.equal(formatSubscriptionDate('2026-02-15T00:00:00.000Z'), '15 февраля 2026');
  assert.equal(formatSubscriptionAmount(subscription), '799 ₽');
  assert.equal(subscriptionPresentation(subscription).showRenew, false);
  assert.equal(subscriptionPresentation({ ...subscription, status: 'expired' }).tone, 'danger');
  assert.equal(
    subscriptionPresentation({ ...subscription, status: 'expired' }).primaryActionLabel,
    'Продлить подписку',
  );
  assert.equal(subscriptionPresentation({ ...subscription, status: 'pending' }).showRenew, false);
});

test('T13 settings keeps permission, browser subscription and backend registration separate', () => {
  const initial = renderSettings();
  assert.ok(initial.includes('data-testid="settings-push-device"'));
  assert.ok(initial.includes('data-permission="default"'));
  assert.ok(initial.includes('data-browser-subscribed="false"'));
  assert.ok(initial.includes('data-backend-registration="unknown"'));
  assert.ok(initial.includes('data-testid="settings-push-enable"'));
  assert.equal(initial.includes('data-testid="settings-push-disable"'), false);
  assert.ok(initial.includes('Не запрошено'));
  assert.ok(initial.includes('Не создана'));
  assert.ok(initial.includes('Не подтверждено'));

  const registered = renderSettings(subscription, {
    permission: 'granted',
    browserSubscribed: true,
    backendRegistration: 'registered',
    busy: false,
    error: null,
  });
  assert.ok(registered.includes('data-permission="granted"'));
  assert.ok(registered.includes('data-browser-subscribed="true"'));
  assert.ok(registered.includes('data-backend-registration="registered"'));
  assert.equal(registered.includes('data-testid="settings-push-enable"'), false);
  assert.ok(registered.includes('data-testid="settings-push-disable"'));
  assert.ok(registered.includes('Подключено'));

  const denied = renderSettings(subscription, {
    permission: 'denied',
    browserSubscribed: false,
    backendRegistration: 'error',
    busy: false,
    error: 'Регистрация не выполнена.',
  });
  assert.equal(denied.includes('data-testid="settings-push-enable"'), false);
  assert.ok(denied.includes('настройках браузера или устройства'));
  assert.ok(denied.includes('data-testid="settings-push-error"'));

  console.log('KINETRA_T13_SETTINGS_INTEGRATION=PASS');
});

test('T13 account deletion retains and awaits the browser subscription before destructive cleanup', async () => {
  const events: string[] = [];
  const capturedSubscription = { endpoint: 'https://push.example/device-account-delete' };
  let currentSubscription: PushSubscription | null = capturedSubscription as PushSubscription;
  let releaseBrowserCleanup: (() => void) | undefined;
  const browserCleanup = new Promise<void>((resolve) => {
    releaseBrowserCleanup = resolve;
  });

  const lifecycle = runAccountDeletionLifecycle('DELETE', {
    prepareAccountDeletion: (confirmation) => {
      events.push('account:bind');
      assert.equal(confirmation, 'DELETE');
      return async () => {
        events.push('account:delete');
      };
    },
    onChatSessionSuspend: () => {
      events.push('chat:suspend-sync');
    },
    captureBrowserSubscription: async () => {
      events.push('browser:capture');
      const captured = currentSubscription;
      currentSubscription = null;
      return captured;
    },
    unsubscribeBrowserSubscription: async (subscriptionToRemove) => {
      events.push('browser:unsubscribe:start');
      assert.equal(subscriptionToRemove, capturedSubscription);
      await browserCleanup;
      events.push('browser:unsubscribe:complete');
    },
    onChatSessionEnd: () => {
      events.push('chat:terminal-clear');
    },
    onSignedOut: () => {
      events.push('auth:clear-and-navigate');
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    'account:bind',
    'chat:suspend-sync',
    'browser:capture',
    'browser:unsubscribe:start',
  ]);

  releaseBrowserCleanup?.();
  await lifecycle;

  assert.deepEqual(events, [
    'account:bind',
    'chat:suspend-sync',
    'browser:capture',
    'browser:unsubscribe:start',
    'browser:unsubscribe:complete',
    'account:delete',
    'chat:terminal-clear',
    'auth:clear-and-navigate',
  ]);
  console.log('KINETRA_T12_T13_COEXISTENCE=PASS');
});

test('failed account deletion preserves auth and restarts chat after every suspended failure', async () => {
  for (const failurePoint of ['capture', 'unsubscribe', 'delete'] as const) {
    const events: string[] = [];
    let authenticated = true;
    let draft = 'Сохранённый черновик';
    let badge = 0;
    let emitUnread: ((unread: number) => void) | null = null;

    const lifecycle = runAccountDeletionLifecycle('DELETE', {
      prepareAccountDeletion: () => async () => {
        events.push('account:delete');
        if (failurePoint === 'delete') {
          throw new Error('delete failed');
        }
      },
      onChatSessionSuspend: () => {
        events.push('chat:suspend');
      },
      captureBrowserSubscription: async () => {
        events.push('browser:capture');
        if (failurePoint === 'capture') {
          throw new Error('capture failed');
        }
        return { endpoint: 'https://push.example/delete-retry' } as PushSubscription;
      },
      unsubscribeBrowserSubscription: async () => {
        events.push('browser:unsubscribe');
        if (failurePoint === 'unsubscribe') {
          throw new Error('unsubscribe failed');
        }
      },
      onChatSessionRestart: () => {
        events.push('chat:restart-and-subscribe');
        emitUnread = (unread) => {
          badge = unread;
        };
      },
      onChatSessionEnd: () => {
        draft = '';
        events.push('chat:terminal-clear');
      },
      onSignedOut: () => {
        authenticated = false;
      },
    });

    await assert.rejects(lifecycle, new RegExp(`${failurePoint} failed`, 'u'));
    assert.equal(authenticated, true);
    assert.equal(draft, 'Сохранённый черновик');
    assert.equal(events[0], 'chat:suspend');
    assert.equal(events.at(-1), 'chat:restart-and-subscribe');
    assert.equal(events.includes('chat:terminal-clear'), false);
    assert.notEqual(emitUnread, null);
    emitUnread?.(4);
    assert.equal(badge, 4, `chat badge must update after ${failurePoint} recovery`);
  }
});

test('failed deletion uses the runtime restart path to resubscribe, reload and update the badge', async () => {
  const events: string[] = [];
  let authenticated = true;
  let draft = 'Черновик остаётся';
  let badge = 0;
  let activeListener: ((unread: number) => void) | null = null;
  let unsubscribeCurrent: (() => void) | null = () => events.push('chat:unsubscribe-old');

  await assert.rejects(
    runAccountDeletionLifecycle('DELETE', {
      prepareAccountDeletion: () => async () => {
        events.push('account:delete');
        throw new Error('delete failed');
      },
      captureBrowserSubscription: async () => null,
      unsubscribeBrowserSubscription: async () => undefined,
      onChatSessionSuspend: () => events.push('chat:suspend'),
      onChatSessionRestart: () => {
        const previousUnsubscribe = unsubscribeCurrent;
        unsubscribeCurrent = restartChatRuntime({
          invalidateSessionRequests: () => events.push('chat:invalidate-get'),
          unsubscribeCurrent: previousUnsubscribe,
          disconnect: () => events.push('chat:disconnect'),
          revokeObjectUrls: () => events.push('chat:revoke-media'),
          available: true,
          resetUnavailable: () => events.push('chat:idle'),
          getConnectionState: () => 'connecting',
          setConnectionState: (state) => events.push(`chat:state:${state}`),
          subscribe: () => {
            events.push('chat:subscribe-new');
            activeListener = (unread) => {
              badge = unread;
            };
            return () => events.push('chat:unsubscribe-new');
          },
          loadSession: () => {
            events.push('api:get-session');
            void Promise.resolve().then(() => events.push('chat:connect'));
          },
        });
      },
      onChatSessionEnd: () => {
        draft = '';
      },
      onSignedOut: () => {
        authenticated = false;
      },
    }),
    /delete failed/u,
  );
  await Promise.resolve();

  assert.equal(authenticated, true);
  assert.equal(draft, 'Черновик остаётся');
  assert.deepEqual(events, [
    'chat:suspend',
    'account:delete',
    'chat:invalidate-get',
    'chat:unsubscribe-old',
    'chat:disconnect',
    'chat:revoke-media',
    'chat:state:connecting',
    'chat:subscribe-new',
    'api:get-session',
    'chat:connect',
  ]);
  assert.notEqual(activeListener, null);
  activeListener?.(6);
  assert.equal(badge, 6);
  unsubscribeCurrent?.();
});
