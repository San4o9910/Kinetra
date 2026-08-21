import type {
  NotificationPreferences,
  SettingsProfileResponse,
  SubscriptionResponse,
} from '@kinetra/shared';
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  ApiRequestError,
  deleteAccount,
  getSettingsProfile,
  getSubscription,
  logout,
  updateNotifications,
} from '../../lib/api';
import { useTheme } from '../theme/theme-context';
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

export interface SettingsScreenProps {
  readonly hasSurvey: boolean;
  readonly onClose: () => void;
  readonly onEditSurvey: () => void;
  readonly onSignedOut: () => void;
  readonly onSessionExpired: () => void;
}

const runtimeEnv = (typeof import.meta.env === 'object' ? import.meta.env : {}) as ImportMetaEnv;
const supportEmail = runtimeEnv.VITE_SUPPORT_EMAIL ?? 'coach@kinetra.app';
const paymentUrl = runtimeEnv.VITE_PAYMENT_URL ?? 'https://kinetra.app/subscribe';
const privacyUrl = runtimeEnv.VITE_PRIVACY_URL ?? 'https://kinetra.app/privacy';
const appVersion = runtimeEnv.VITE_APP_VERSION ?? '0.4.0';

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
  const requestControllerRef = useRef<AbortController | null>(null);
  const requestVersionRef = useRef(0);
  const lastSavedNotificationsRef = useRef<string | null>(null);
  const lastQueuedNotificationsRef = useRef<string | null>(null);
  const latestNotificationsRef = useRef<NotificationPreferences | null>(null);
  const notificationSaveVersionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const isMountedRef = useRef(true);

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
  }, [handleApiError]);

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
    void logout()
      .catch(() => undefined)
      .finally(onSignedOut);
  };

  const confirmDelete = (): void => {
    if (dialogBusy || deleteConfirmation !== 'DELETE') {
      return;
    }

    setDialogBusy(true);
    setDialogError(null);
    void deleteAccount(deleteConfirmation)
      .then(onSignedOut)
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
        hasSurvey={hasSurvey}
        themePreference={preference}
        resolvedTheme={resolvedTheme}
        supportEmail={supportEmail}
        paymentUrl={paymentUrl}
        onClose={onClose}
        onNotificationsChange={setNotifications}
        onThemeChange={setPreference}
        onEditSurvey={onEditSurvey}
        onOpenLevel={() => openDialog('level')}
        onOpenAbout={() => openDialog('about')}
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
        onLogout={confirmLogout}
        onDelete={confirmDelete}
      />
    </React.Fragment>
  );
};
