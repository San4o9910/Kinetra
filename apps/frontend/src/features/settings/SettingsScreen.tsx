import type {
  NotificationPreferences,
  SettingsProfileResponse,
  SubscriptionResponse,
} from '@kinetra/shared';
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  ApiRequestError,
  cancelSubscription,
  deleteAccount,
  getSettingsProfile,
  getSubscription,
  logout,
  updateNotifications,
} from '../../lib/api';
import { useTheme } from '../theme/theme-context';
import {
  PushNotificationError,
  bestEffortUnsubscribeFromPush,
  getExistingPushSubscription,
  getPushPermission,
  subscribeToPush,
  unsubscribeBrowserOnly,
  unsubscribeFromPush,
  type PushBackendRegistrationStatus,
  type PushPermission,
} from '../../pwa/pushNotifications';
import { SettingsDialogs, type SettingsDialogKind } from './SettingsDialogs';
import { SettingsView, type NotificationSaveStatus } from './SettingsView';
import { SETTINGS_NOTIFICATION_DEBOUNCE_MS } from './model';

type SettingsLoadState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly profile: SettingsProfileResponse;
      readonly subscription: SubscriptionResponse;
    }
  | { readonly kind: 'error'; readonly message: string };

interface PushDeviceState {
  readonly permission: PushPermission;
  readonly browserSubscribed: boolean;
  readonly backendRegistration: PushBackendRegistrationStatus;
  readonly busy: boolean;
  readonly error: string | null;
}

export interface SettingsScreenProps {
  readonly hasSurvey: boolean;
  readonly onClose: () => void;
  readonly onEditSurvey: () => void;
  readonly onOpenPayment: () => void;
  readonly onSubscriptionUpdated: (subscription: SubscriptionResponse) => void;
  readonly onSignedOut: () => void;
  readonly onSessionExpired: () => void;
}

const runtimeEnv = (typeof import.meta.env === 'object' ? import.meta.env : {}) as ImportMetaEnv;
const supportEmail = runtimeEnv.VITE_SUPPORT_EMAIL ?? 'coach@kinetra.app';
const privacyUrl = runtimeEnv.VITE_PRIVACY_URL ?? 'https://kinetra.app/privacy';
const appVersion = runtimeEnv.VITE_APP_VERSION ?? '0.4.0';
const PUSH_BEST_EFFORT_TIMEOUT_MS = 1_500;

const settleBestEffortWithin = async (operation: Promise<unknown>): Promise<void> => {
  let timer: number | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = window.setTimeout(resolve, PUSH_BEST_EFFORT_TIMEOUT_MS);
  });

  await Promise.race([operation.catch(() => undefined), timeout]);

  if (timer !== undefined) {
    window.clearTimeout(timer);
  }
};

const initialPushDeviceState = (): PushDeviceState => ({
  permission: getPushPermission(),
  browserSubscribed: false,
  backendRegistration: 'unknown',
  busy: false,
  error: null,
});

const SettingsState = ({
  kind,
  message,
  onRetry,
}: {
  readonly kind: 'loading' | 'error';
  readonly message: string;
  readonly onRetry?: () => void;
}): ReactNode => (
  <main className="settings-state-shell" data-testid="settings-screen">
    <section className="settings-state-card" aria-live="polite">
      <p className="settings-state-kicker">НАСТРОЙКИ</p>
      <h1>{kind === 'loading' ? 'Загружаем профиль' : 'Не удалось открыть настройки'}</h1>
      <p>{message}</p>
      {onRetry === undefined ? null : (
        <button className="primary-button" type="button" onClick={onRetry}>
          Повторить
        </button>
      )}
    </section>
  </main>
);

export const SettingsScreen = ({
  hasSurvey,
  onClose,
  onEditSurvey,
  onOpenPayment,
  onSubscriptionUpdated,
  onSignedOut,
  onSessionExpired,
}: SettingsScreenProps): ReactNode => {
  const { preference, resolvedTheme, setPreference } = useTheme();
  const [loadState, setLoadState] = useState<SettingsLoadState>({ kind: 'loading' });
  const [notifications, setNotifications] = useState<NotificationPreferences | null>(null);
  const [notificationSaveStatus, setNotificationSaveStatus] =
    useState<NotificationSaveStatus>('idle');
  const [activeDialog, setActiveDialog] = useState<SettingsDialogKind>(null);
  const [deleteStage, setDeleteStage] = useState<1 | 2>(1);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pushDeviceState, setPushDeviceState] = useState<PushDeviceState>(initialPushDeviceState);
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestVersionRef = useRef(0);
  const lastSavedNotificationsRef = useRef<string | null>(null);
  const lastQueuedNotificationsRef = useRef<string | null>(null);
  const latestNotificationsRef = useRef<NotificationPreferences | null>(null);
  const notificationSaveVersionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const isMountedRef = useRef(true);
  const pushActionInFlightRef = useRef(false);

  latestNotificationsRef.current = notifications;

  const handleApiError = useCallback(
    (error: unknown, fallback: string): string => {
      if (error instanceof ApiRequestError) {
        if (error.kind === 'auth') {
          onSessionExpired();
        }

        return error.message;
      }

      return fallback;
    },
    [onSessionExpired],
  );

  const queueNotificationSave = useCallback(
    (
      snapshot: NotificationPreferences,
      serialized: string,
      saveVersion: number,
      announceStatus: boolean,
    ): void => {
      lastQueuedNotificationsRef.current = serialized;
      const save = saveQueueRef.current
        .catch(() => undefined)
        .then(() => updateNotifications(snapshot));
      saveQueueRef.current = save;

      void save
        .then(() => {
          lastSavedNotificationsRef.current = serialized;

          if (
            announceStatus &&
            isMountedRef.current &&
            saveVersion === notificationSaveVersionRef.current
          ) {
            setNotificationSaveStatus('saved');
          }
        })
        .catch((error: unknown) => {
          if (lastQueuedNotificationsRef.current === serialized) {
            lastQueuedNotificationsRef.current = lastSavedNotificationsRef.current;
          }

          handleApiError(error, 'Не удалось сохранить настройки уведомлений.');

          if (
            announceStatus &&
            isMountedRef.current &&
            saveVersion === notificationSaveVersionRef.current
          ) {
            setNotificationSaveStatus('error');
          }
        });
    },
    [handleApiError],
  );

  const loadSettings = useCallback((): void => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    const requestVersion = ++requestVersionRef.current;
    requestControllerRef.current = controller;
    setLoadState({ kind: 'loading' });

    void Promise.all([getSettingsProfile(controller.signal), getSubscription(controller.signal)])
      .then(([profile, subscription]) => {
        if (controller.signal.aborted || requestVersion !== requestVersionRef.current) {
          return;
        }

        const serialized = JSON.stringify(profile.notification_preferences);
        lastSavedNotificationsRef.current = serialized;
        lastQueuedNotificationsRef.current = serialized;
        latestNotificationsRef.current = profile.notification_preferences;
        setNotifications(profile.notification_preferences);
        setNotificationSaveStatus('idle');
        setLoadState({ kind: 'ready', profile, subscription });
        onSubscriptionUpdated(subscription);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestVersion !== requestVersionRef.current) {
          return;
        }

        const message = handleApiError(
          error,
          'Не удалось загрузить настройки. Проверьте соединение и попробуйте ещё раз.',
        );
        setLoadState({ kind: 'error', message });
      });
  }, [handleApiError, onSubscriptionUpdated]);

  useEffect(() => {
    loadSettings();
    return () => {
      requestControllerRef.current?.abort();
      requestVersionRef.current += 1;
    };
  }, [loadSettings]);

  useEffect(() => {
    isMountedRef.current = true;

    const flushPendingNotifications = (): void => {
      const snapshot = latestNotificationsRef.current;

      if (snapshot === null) {
        return;
      }

      const serialized = JSON.stringify(snapshot);

      if (
        serialized === lastSavedNotificationsRef.current ||
        serialized === lastQueuedNotificationsRef.current
      ) {
        return;
      }

      const saveVersion = ++notificationSaveVersionRef.current;
      queueNotificationSave(snapshot, serialized, saveVersion, false);
    };

    window.addEventListener('pagehide', flushPendingNotifications);

    return () => {
      isMountedRef.current = false;
      window.removeEventListener('pagehide', flushPendingNotifications);
      flushPendingNotifications();
    };
  }, [queueNotificationSave]);

  useEffect(() => {
    if (notifications === null) {
      return;
    }

    const serialized = JSON.stringify(notifications);

    if (serialized === lastSavedNotificationsRef.current) {
      return;
    }

    const snapshot = notifications;
    const saveVersion = ++notificationSaveVersionRef.current;
    setNotificationSaveStatus('saving');
    const timer = window.setTimeout(() => {
      queueNotificationSave(snapshot, serialized, saveVersion, true);
    }, SETTINGS_NOTIFICATION_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [notifications, queueNotificationSave]);

  const pushErrorMessage = useCallback(
    (error: unknown): string => {
      if (error instanceof PushNotificationError) {
        return error.message;
      }

      return handleApiError(error, 'Не удалось изменить push-подписку. Попробуйте ещё раз.');
    },
    [handleApiError],
  );

  const refreshPushDeviceState = useCallback(async (): Promise<void> => {
    if (pushActionInFlightRef.current) {
      return;
    }

    const permission = getPushPermission();

    if (permission === 'unsupported') {
      if (isMountedRef.current) {
        setPushDeviceState({
          permission,
          browserSubscribed: false,
          backendRegistration: 'unknown',
          busy: false,
          error: null,
        });
      }
      return;
    }

    try {
      const subscription = await getExistingPushSubscription();

      if (isMountedRef.current && !pushActionInFlightRef.current) {
        setPushDeviceState((current) => ({
          permission: getPushPermission(),
          browserSubscribed: subscription !== null,
          backendRegistration:
            subscription !== null && current.backendRegistration === 'registered'
              ? 'registered'
              : subscription === null && current.backendRegistration === 'not_registered'
                ? 'not_registered'
                : 'unknown',
          busy: false,
          error: null,
        }));
      }
    } catch {
      if (isMountedRef.current && !pushActionInFlightRef.current) {
        setPushDeviceState({
          permission: getPushPermission(),
          browserSubscribed: false,
          backendRegistration: 'unknown',
          busy: false,
          error: 'Не удалось проверить push-подписку этого устройства.',
        });
      }
    }
  }, []);

  useEffect(() => {
    void refreshPushDeviceState();

    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshPushDeviceState();
      }
    };

    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => document.removeEventListener('visibilitychange', refreshWhenVisible);
  }, [refreshPushDeviceState]);

  const enablePushOnDevice = (): void => {
    if (pushActionInFlightRef.current) {
      return;
    }

    pushActionInFlightRef.current = true;
    setPushDeviceState((current) => ({
      ...current,
      backendRegistration: 'registering',
      busy: true,
      error: null,
    }));

    void subscribeToPush()
      .then(() => {
        if (isMountedRef.current) {
          setPushDeviceState({
            permission: getPushPermission(),
            browserSubscribed: true,
            backendRegistration: 'registered',
            busy: false,
            error: null,
          });
        }
      })
      .catch(async (error: unknown) => {
        let browserSubscribed = false;

        try {
          browserSubscribed = (await getExistingPushSubscription()) !== null;
        } catch {
          browserSubscribed = false;
        }

        if (isMountedRef.current) {
          setPushDeviceState({
            permission: getPushPermission(),
            browserSubscribed,
            backendRegistration: 'error',
            busy: false,
            error: pushErrorMessage(error),
          });
        }
      })
      .finally(() => {
        pushActionInFlightRef.current = false;
      });
  };

  const disablePushOnDevice = (): void => {
    if (pushActionInFlightRef.current) {
      return;
    }

    pushActionInFlightRef.current = true;
    setPushDeviceState((current) => ({ ...current, busy: true, error: null }));

    void unsubscribeFromPush()
      .then(() => {
        if (isMountedRef.current) {
          setPushDeviceState({
            permission: getPushPermission(),
            browserSubscribed: false,
            backendRegistration: 'not_registered',
            busy: false,
            error: null,
          });
        }
      })
      .catch(async (error: unknown) => {
        let browserSubscribed = pushDeviceState.browserSubscribed;

        try {
          browserSubscribed = (await getExistingPushSubscription()) !== null;
        } catch {
          // Preserve the last known browser state when it cannot be refreshed.
        }

        if (isMountedRef.current) {
          setPushDeviceState({
            permission: getPushPermission(),
            browserSubscribed,
            backendRegistration: 'error',
            busy: false,
            error: pushErrorMessage(error),
          });
        }
      })
      .finally(() => {
        pushActionInFlightRef.current = false;
      });
  };

  const closeDialog = (): void => {
    if (dialogBusy) {
      return;
    }

    setActiveDialog(null);
    setDeleteStage(1);
    setDeleteConfirmation('');
    setDialogError(null);
  };

  const openDialog = (dialog: Exclude<SettingsDialogKind, null>): void => {
    setDialogError(null);
    setDialogBusy(false);
    setDeleteStage(1);
    setDeleteConfirmation('');
    setActiveDialog(dialog);
  };

  const confirmLogout = (): void => {
    if (dialogBusy) {
      return;
    }

    setDialogBusy(true);
    void settleBestEffortWithin(bestEffortUnsubscribeFromPush())
      .then(() => logout())
      .catch(() => undefined)
      .finally(onSignedOut);
  };

  const confirmCancelSubscription = (): void => {
    if (dialogBusy) {
      return;
    }

    setDialogBusy(true);
    setDialogError(null);
    void cancelSubscription()
      .then((subscription) => {
        setLoadState((current) =>
          current.kind === 'ready' ? { ...current, subscription } : current,
        );
        onSubscriptionUpdated(subscription);
        setDialogBusy(false);
        setActiveDialog(null);
        setDialogError(null);
      })
      .catch((error: unknown) => {
        setDialogBusy(false);
        setDialogError(
          handleApiError(error, 'Не удалось отменить автопродление. Попробуйте ещё раз.'),
        );
      });
  };

  const confirmDelete = (): void => {
    if (dialogBusy || deleteConfirmation !== 'DELETE') {
      return;
    }

    setDialogBusy(true);
    setDialogError(null);
    void deleteAccount(deleteConfirmation)
      .then(async () => {
        await settleBestEffortWithin(unsubscribeBrowserOnly());
        onSignedOut();
      })
      .catch((error: unknown) => {
        setDialogBusy(false);
        setDialogError(handleApiError(error, 'Не удалось удалить аккаунт. Попробуйте ещё раз.'));
      });
  };

  if (loadState.kind === 'loading') {
    return <SettingsState kind="loading" message="Получаем подписку и настройки уведомлений…" />;
  }

  if (loadState.kind === 'error') {
    return <SettingsState kind="error" message={loadState.message} onRetry={loadSettings} />;
  }

  if (notifications === null) {
    return <SettingsState kind="loading" message="Подготавливаем настройки…" />;
  }

  return (
    <React.Fragment>
      <SettingsView
        profile={loadState.profile}
        subscription={loadState.subscription}
        notifications={notifications}
        notificationSaveStatus={notificationSaveStatus}
        pushPermission={pushDeviceState.permission}
        pushBrowserSubscribed={pushDeviceState.browserSubscribed}
        pushBackendRegistration={pushDeviceState.backendRegistration}
        pushBusy={pushDeviceState.busy}
        pushError={pushDeviceState.error}
        hasSurvey={hasSurvey}
        themePreference={preference}
        resolvedTheme={resolvedTheme}
        supportEmail={supportEmail}
        onClose={onClose}
        onNotificationsChange={setNotifications}
        onEnablePush={enablePushOnDevice}
        onDisablePush={disablePushOnDevice}
        onThemeChange={setPreference}
        onEditSurvey={onEditSurvey}
        onOpenLevel={() => openDialog('level')}
        onOpenAbout={() => openDialog('about')}
        onOpenPayment={onOpenPayment}
        onOpenRenewalInfo={() => openDialog('renewal')}
        onOpenLogout={() => openDialog('logout')}
        onOpenDelete={() => openDialog('delete')}
      />
      <SettingsDialogs
        activeDialog={activeDialog}
        appVersion={appVersion}
        privacyUrl={privacyUrl}
        deleteStage={deleteStage}
        deleteConfirmation={deleteConfirmation}
        busy={dialogBusy}
        error={dialogError}
        onClose={closeDialog}
        onContinueDelete={() => setDeleteStage(2)}
        onDeleteConfirmationChange={setDeleteConfirmation}
        onCancelSubscription={confirmCancelSubscription}
        onLogout={confirmLogout}
        onDelete={confirmDelete}
      />
    </React.Fragment>
  );
};
