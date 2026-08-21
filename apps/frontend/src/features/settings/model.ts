import type { SubscriptionResponse } from '@kinetra/shared';

const MONTHS_GENITIVE = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const;

export const notificationTimeOptions: readonly string[] = Array.from({ length: 33 }, (_, index) => {
  const totalMinutes = 6 * 60 + index * 30;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
});

export const SETTINGS_NOTIFICATION_DEBOUNCE_MS = 450;

const parseDate = (value: string): Date | null => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatMemberSince = (createdAt: string): string => {
  const date = parseDate(createdAt);

  if (date === null) {
    return 'Дата регистрации недоступна';
  }

  return `С нами с ${MONTHS_GENITIVE[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

export const formatSubscriptionDate = (value: string): string => {
  const date = parseDate(value);

  if (date === null) {
    return 'дата не указана';
  }

  return `${date.getUTCDate()} ${MONTHS_GENITIVE[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

export type SubscriptionTone = 'active' | 'danger' | 'neutral' | 'pending';

export interface SubscriptionPresentation {
  readonly label: string;
  readonly tone: SubscriptionTone;
  readonly showRenew: boolean;
  readonly showCancelAutoRenew: boolean;
}

export const subscriptionPresentation = (
  subscription: SubscriptionResponse,
): SubscriptionPresentation => {
  if (subscription.status === 'active') {
    return {
      label:
        subscription.expires_at === null
          ? 'Подписка активна'
          : `Активна до ${formatSubscriptionDate(subscription.expires_at)}`,
      tone: 'active',
      showRenew:
        subscription.days_remaining !== null && subscription.days_remaining >= 0
          ? subscription.days_remaining <= 7
          : false,
      showCancelAutoRenew: subscription.auto_renew === true,
    };
  }

  if (subscription.status === 'expired') {
    return {
      label: 'Подписка истекла',
      tone: 'danger',
      showRenew: true,
      showCancelAutoRenew: false,
    };
  }

  if (subscription.status === 'cancelled') {
    return {
      label: 'Подписка отменена',
      tone: 'danger',
      showRenew: true,
      showCancelAutoRenew: false,
    };
  }

  if (subscription.status === 'pending') {
    return {
      label: 'Ожидает подтверждения',
      tone: 'pending',
      showRenew: false,
      showCancelAutoRenew: false,
    };
  }

  return {
    label: 'Нет подписки',
    tone: 'neutral',
    showRenew: true,
    showCancelAutoRenew: false,
  };
};

export const formatSubscriptionAmount = (subscription: SubscriptionResponse): string | null => {
  if (subscription.amount === null || subscription.currency === null) {
    return null;
  }

  const currency = subscription.currency === 'RUB' ? '₽' : subscription.currency;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(
    subscription.amount,
  )} ${currency}`;
};
