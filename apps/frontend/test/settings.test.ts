import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  NotificationPreferences,
  SettingsProfileResponse,
  SubscriptionResponse,
} from '@kinetra/shared';

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

const renderSettings = (fixture: SubscriptionResponse = subscription): string =>
  renderToStaticMarkup(
    createElement(SettingsView, {
      profile,
      subscription: fixture,
      notifications,
      notificationSaveStatus: 'idle',
      hasSurvey: true,
      themePreference: 'system',
      resolvedTheme: 'dark',
      supportEmail: 'coach@kinetra.app',
      paymentUrl: 'https://kinetra.app/subscribe',
      onClose: () => undefined,
      onNotificationsChange: () => undefined,
      onThemeChange: () => undefined,
      onEditSurvey: () => undefined,
      onOpenLevel: () => undefined,
      onOpenAbout: () => undefined,
      onOpenRenewalInfo: () => undefined,
      onOpenLogout: () => undefined,
      onOpenDelete: () => undefined,
    }),
  );

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

test('subscription card renders provider, amount, expiry and renewal actions', () => {
  const markup = renderSettings();
  assert.ok(markup.includes('Активна до 15 февраля 2026'));
  assert.ok(markup.includes('ЮKassa'));
  assert.ok(markup.includes('799 ₽'));
  assert.ok(markup.includes('Продлить'));
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
  assert.equal(noneMarkup.includes('ЮKassa'), false);
});

test('settings dialogs expose logout confirmation and two-stage destructive deletion', () => {
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

test('settings model fixes date, time, debounce and subscription-state contracts', () => {
  assert.equal(notificationTimeOptions.length, 33);
  assert.equal(notificationTimeOptions[0], '06:00');
  assert.equal(notificationTimeOptions.at(-1), '22:00');
  assert.equal(SETTINGS_NOTIFICATION_DEBOUNCE_MS, 450);
  assert.equal(formatMemberSince(profile.created_at), 'С нами с января 2026');
  assert.equal(formatSubscriptionDate('2026-02-15T00:00:00.000Z'), '15 февраля 2026');
  assert.equal(formatSubscriptionAmount(subscription), '799 ₽');
  assert.equal(subscriptionPresentation(subscription).showRenew, true);
  assert.equal(subscriptionPresentation({ ...subscription, status: 'expired' }).tone, 'danger');
  assert.equal(subscriptionPresentation({ ...subscription, status: 'pending' }).showRenew, false);
});
