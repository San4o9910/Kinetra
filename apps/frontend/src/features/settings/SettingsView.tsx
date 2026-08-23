import type {
  NotificationPreferences,
  SettingsProfileResponse,
  SubscriptionResponse,
} from '@kinetra/shared';
import React, { type ReactNode } from 'react';

import type { PushBackendRegistrationStatus, PushPermission } from '../../pwa/pushNotifications';
import { themeOptions, type ResolvedTheme, type ThemePreference } from '../theme/model';
import { ChevronIcon, SettingsIcon, ThemeModeIcon } from './SettingsIcons';
import {
  formatMemberSince,
  formatSubscriptionAmount,
  notificationTimeOptions,
  subscriptionPresentation,
} from './model';

export type NotificationSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface SettingsViewProps {
  readonly profile: SettingsProfileResponse;
  readonly subscription: SubscriptionResponse;
  readonly notifications: NotificationPreferences;
  readonly notificationSaveStatus: NotificationSaveStatus;
  readonly pushPermission: PushPermission;
  readonly pushBrowserSubscribed: boolean;
  readonly pushBackendRegistration: PushBackendRegistrationStatus;
  readonly pushBusy: boolean;
  readonly pushError: string | null;
  readonly hasSurvey: boolean;
  readonly themePreference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly supportEmail: string;
  readonly onClose: () => void;
  readonly onNotificationsChange: (preferences: NotificationPreferences) => void;
  readonly onEnablePush: () => void;
  readonly onDisablePush: () => void;
  readonly onThemeChange: (preference: ThemePreference) => void;
  readonly onEditSurvey: () => void;
  readonly onOpenLevel: () => void;
  readonly onOpenAbout: () => void;
  readonly onOpenPayment: () => void;
  readonly onOpenRenewalInfo: () => void;
  readonly onOpenLogout: () => void;
  readonly onOpenDelete: () => void;
}

const Section = ({
  title,
  testId,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode => (
  <section className="settings-section" data-testid={testId} aria-labelledby={`${testId}-title`}>
    <h2 id={`${testId}-title`}>{title}</h2>
    {children}
  </section>
);

const MenuButton = ({
  icon,
  title,
  detail,
  testId,
  danger = false,
  disabled = false,
  onClick,
}: {
  readonly icon: Parameters<typeof SettingsIcon>[0]['name'];
  readonly title: string;
  readonly detail?: string;
  readonly testId: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}): ReactNode => (
  <button
    className={`settings-row settings-menu-button${danger ? ' is-danger' : ''}`}
    data-testid={testId}
    type="button"
    disabled={disabled}
    onClick={onClick}
  >
    <SettingsIcon name={icon} />
    <span className="settings-row-copy">
      <strong>{title}</strong>
      {detail === undefined ? null : <small>{detail}</small>}
    </span>
    <ChevronIcon />
  </button>
);

const ToggleRow = ({
  testId,
  label,
  checked,
  onChange,
}: {
  readonly testId: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}): ReactNode => (
  <label className="settings-row settings-toggle-row" data-testid={`${testId}-row`}>
    <SettingsIcon name="bell" />
    <span className="settings-row-copy">
      <strong>{label}</strong>
    </span>
    <input
      data-testid={testId}
      type="checkbox"
      role="switch"
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
    <span className="settings-toggle" aria-hidden="true">
      <span />
    </span>
  </label>
);

const pushPermissionLabel = (permission: PushPermission): string => {
  if (permission === 'unsupported') {
    return 'Не поддерживается';
  }

  if (permission === 'granted') {
    return 'Разрешено';
  }

  return permission === 'denied' ? 'Запрещено' : 'Не запрошено';
};

const pushBackendLabel = (status: PushBackendRegistrationStatus): string => {
  if (status === 'registering') {
    return 'Подключаем';
  }

  if (status === 'registered') {
    return 'Подключено';
  }

  if (status === 'not_registered') {
    return 'Не подключено';
  }

  return status === 'error' ? 'Ошибка подключения' : 'Не подтверждено';
};

const PushDeviceCard = ({
  preferenceEnabled,
  permission,
  browserSubscribed,
  backendRegistration,
  busy,
  error,
  onEnable,
  onDisable,
}: {
  readonly preferenceEnabled: boolean;
  readonly permission: PushPermission;
  readonly browserSubscribed: boolean;
  readonly backendRegistration: PushBackendRegistrationStatus;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onEnable: () => void;
  readonly onDisable: () => void;
}): ReactNode => {
  const permissionBlocked = permission === 'unsupported' || permission === 'denied';
  const enableLabel = browserSubscribed
    ? backendRegistration === 'error'
      ? 'Повторить подключение'
      : 'Подтвердить подключение'
    : 'Включить на этом устройстве';

  return (
    <div
      className="settings-push-device"
      data-testid="settings-push-device"
      data-permission={permission}
      data-browser-subscribed={browserSubscribed ? 'true' : 'false'}
      data-backend-registration={backendRegistration}
    >
      <div className="settings-push-device-heading">
        <div>
          <strong>Push на этом устройстве</strong>
          <p>Настройки типов уведомлений синхронизируются отдельно от разрешения браузера.</p>
        </div>
        <SettingsIcon name="bell" />
      </div>

      <dl className="settings-push-device-state" aria-live="polite">
        <div>
          <dt>Разрешение браузера</dt>
          <dd data-testid="settings-push-permission">{pushPermissionLabel(permission)}</dd>
        </div>
        <div>
          <dt>Подписка браузера</dt>
          <dd data-testid="settings-push-browser-state">
            {browserSubscribed ? 'Создана' : 'Не создана'}
          </dd>
        </div>
        <div>
          <dt>Регистрация Kinetra</dt>
          <dd data-testid="settings-push-backend-state">{pushBackendLabel(backendRegistration)}</dd>
        </div>
      </dl>

      {!preferenceEnabled && browserSubscribed ? (
        <p className="settings-push-device-note">
          Типы уведомлений выключены. Подписка устройства сохранена для быстрого включения.
        </p>
      ) : null}
      {permission === 'unsupported' ? (
        <p className="settings-push-device-note">
          Этот браузер или режим не поддерживает Web Push. На iPhone откройте установленную PWA с
          экрана «Домой».
        </p>
      ) : null}
      {permission === 'denied' ? (
        <p className="settings-push-device-note">
          Разрешите уведомления для Kinetra в настройках браузера или устройства. Повторный запрос
          здесь недоступен.
        </p>
      ) : null}
      {error === null ? null : (
        <p className="settings-push-device-error" data-testid="settings-push-error" role="alert">
          {error}
        </p>
      )}

      {permissionBlocked || backendRegistration === 'registered' ? null : (
        <button
          className="settings-push-primary"
          data-testid="settings-push-enable"
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={onEnable}
        >
          {busy ? 'Подключаем…' : enableLabel}
        </button>
      )}
      {browserSubscribed ? (
        <button
          className="settings-push-secondary"
          data-testid="settings-push-disable"
          type="button"
          disabled={busy}
          onClick={onDisable}
        >
          Отключить на этом устройстве
        </button>
      ) : null}
    </div>
  );
};

const SubscriptionCard = ({
  subscription,
  onOpenPayment,
  onOpenRenewalInfo,
}: {
  readonly subscription: SubscriptionResponse;
  readonly onOpenPayment: () => void;
  readonly onOpenRenewalInfo: () => void;
}): ReactNode => {
  const presentation = subscriptionPresentation(subscription);
  const amount = formatSubscriptionAmount(subscription);

  return (
    <div
      className={`settings-subscription-card is-${presentation.tone}`}
      data-testid="settings-subscription-card"
      data-status={subscription.status}
    >
      <div className="settings-subscription-heading">
        <div>
          <span className="settings-subscription-label">Текущий статус</span>
          <strong data-testid="settings-subscription-status">{presentation.label}</strong>
        </div>
        <SettingsIcon name="subscription" />
      </div>

      {subscription.provider === null ? null : (
        <div className="settings-provider" data-testid="settings-subscription-provider">
          <span className={`settings-provider-mark is-${subscription.provider}`} aria-hidden="true">
            {subscription.provider === 'yukassa' ? 'Ю' : 'T'}
          </span>
          <span>{subscription.provider === 'yukassa' ? 'ЮKassa' : 'Tribute'}</span>
          {amount === null ? null : <span className="settings-subscription-amount">{amount}</span>}
        </div>
      )}

      {subscription.status === 'active' && subscription.auto_renew === false ? (
        <p className="settings-auto-renew-state" data-testid="settings-auto-renew-state">
          Автопродление отключено
        </p>
      ) : null}

      {presentation.showRenew || presentation.showCancelAutoRenew ? (
        <div className="settings-subscription-actions">
          {presentation.showRenew ? (
            <button
              className="settings-subscription-primary"
              data-testid="settings-renew-subscription"
              type="button"
              onClick={onOpenPayment}
            >
              {presentation.primaryActionLabel}
            </button>
          ) : null}
          {presentation.showCancelAutoRenew ? (
            <button
              className="settings-subscription-secondary"
              data-testid="settings-cancel-auto-renew"
              type="button"
              onClick={onOpenRenewalInfo}
            >
              Отменить автопродление
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const SettingsView = ({
  profile,
  subscription,
  notifications,
  notificationSaveStatus,
  pushPermission,
  pushBrowserSubscribed,
  pushBackendRegistration,
  pushBusy,
  pushError,
  hasSurvey,
  themePreference,
  resolvedTheme,
  supportEmail,
  onClose,
  onNotificationsChange,
  onEnablePush,
  onDisablePush,
  onThemeChange,
  onEditSurvey,
  onOpenLevel,
  onOpenAbout,
  onOpenPayment,
  onOpenRenewalInfo,
  onOpenLogout,
  onOpenDelete,
}: SettingsViewProps): ReactNode => (
  <React.Fragment>
    <main className="settings-shell" data-testid="settings-screen">
      <div className="settings-panel">
        <header className="settings-header">
          <div className="settings-header-copy">
            <p>Настройки</p>
            <h1>{profile.email ?? profile.phone ?? 'Профиль Kinetra'}</h1>
            <span data-testid="settings-member-since">{formatMemberSince(profile.created_at)}</span>
          </div>
          <button
            className="settings-close"
            data-testid="close-settings"
            type="button"
            aria-label="Закрыть настройки"
            onClick={onClose}
          >
            Закрыть
          </button>
        </header>

        <Section title="Подписка" testId="settings-subscription-section">
          <SubscriptionCard
            subscription={subscription}
            onOpenPayment={onOpenPayment}
            onOpenRenewalInfo={onOpenRenewalInfo}
          />
        </Section>

        <Section title="Уведомления" testId="settings-notifications-section">
          <div className="settings-group">
            <ToggleRow
              testId="settings-workout-reminders"
              label="Напоминания о тренировках"
              checked={notifications.workout_reminders}
              onChange={(workoutReminders) =>
                onNotificationsChange({
                  ...notifications,
                  workout_reminders: workoutReminders,
                })
              }
            />
            {notifications.workout_reminders ? (
              <label className="settings-row settings-time-row">
                <span className="settings-time-spacer" aria-hidden="true" />
                <span className="settings-row-copy">
                  <strong>Время напоминания</strong>
                </span>
                <select
                  data-testid="settings-reminder-time"
                  value={notifications.reminder_time}
                  onChange={(event) =>
                    onNotificationsChange({
                      ...notifications,
                      reminder_time: event.currentTarget.value,
                    })
                  }
                >
                  {notificationTimeOptions.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <ToggleRow
              testId="settings-weekly-survey-reminder"
              label="Напоминание об оценке недели"
              checked={notifications.weekly_survey_reminder}
              onChange={(weeklySurveyReminder) =>
                onNotificationsChange({
                  ...notifications,
                  weekly_survey_reminder: weeklySurveyReminder,
                })
              }
            />
          </div>
          <p
            className={`settings-save-state is-${notificationSaveStatus}`}
            data-testid="settings-notification-save-status"
            role="status"
            aria-live="polite"
          >
            {notificationSaveStatus === 'saving'
              ? 'Сохраняем…'
              : notificationSaveStatus === 'saved'
                ? 'Сохранено'
                : notificationSaveStatus === 'error'
                  ? 'Не удалось сохранить. Измените настройку, чтобы повторить.'
                  : 'Изменения сохраняются автоматически'}
          </p>
          <PushDeviceCard
            preferenceEnabled={
              notifications.workout_reminders || notifications.weekly_survey_reminder
            }
            permission={pushPermission}
            browserSubscribed={pushBrowserSubscribed}
            backendRegistration={pushBackendRegistration}
            busy={pushBusy}
            error={pushError}
            onEnable={onEnablePush}
            onDisable={onDisablePush}
          />
        </Section>

        <Section title="Профиль" testId="settings-profile-section">
          <div className="settings-group">
            <MenuButton
              icon="profile"
              title="Редактировать анкету"
              {...(hasSurvey ? {} : { detail: 'Сначала заполните анкету' })}
              testId="edit-survey"
              disabled={!hasSurvey}
              onClick={onEditSurvey}
            />
            <MenuButton
              icon="level"
              title="Сменить уровень"
              testId="settings-change-level"
              onClick={onOpenLevel}
            />
          </div>
        </Section>

        <Section title="Оформление" testId="settings-appearance-section">
          <fieldset className="settings-theme-fieldset">
            <legend className="visually-hidden">Тема приложения</legend>
            <div className="settings-theme-options" data-testid="settings-theme-options">
              {themeOptions.map((option) => (
                <label
                  key={option.value}
                  className={`settings-theme-option${
                    themePreference === option.value ? ' is-selected' : ''
                  }`}
                  data-testid={`settings-theme-${option.value}`}
                >
                  <input
                    type="radio"
                    name="kinetra-theme"
                    value={option.value}
                    checked={themePreference === option.value}
                    onChange={() => onThemeChange(option.value)}
                  />
                  <span className="settings-theme-symbol" aria-hidden="true">
                    <ThemeModeIcon mode={option.value} />
                  </span>
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p
            className="settings-theme-current"
            data-testid="settings-theme-current"
            aria-live="polite"
          >
            Сейчас используется {resolvedTheme === 'dark' ? 'тёмная' : 'светлая'} тема
          </p>
        </Section>

        <Section title="Поддержка" testId="settings-support-section">
          <div className="settings-group">
            <a
              className="settings-row settings-menu-link"
              data-testid="settings-contact-coach"
              href={`mailto:${supportEmail}`}
            >
              <SettingsIcon name="coach" />
              <span className="settings-row-copy">
                <strong>Связаться с тренером</strong>
                <small>{supportEmail}</small>
              </span>
              <ChevronIcon />
            </a>
            <MenuButton
              icon="about"
              title="О приложении"
              testId="settings-about"
              onClick={onOpenAbout}
            />
          </div>
        </Section>

        <Section title="Аккаунт" testId="settings-account-section">
          <div className="settings-group">
            <MenuButton
              icon="logout"
              title="Выйти из аккаунта"
              testId="logout"
              onClick={onOpenLogout}
            />
            <MenuButton
              icon="delete"
              title="Удалить аккаунт"
              testId="settings-delete-account"
              danger
              onClick={onOpenDelete}
            />
          </div>
        </Section>
      </div>
    </main>
  </React.Fragment>
);
