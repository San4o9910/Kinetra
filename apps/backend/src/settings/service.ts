import type {
  NotificationPreferences,
  SettingsProfileResponse,
  SettingsSubscriptionStatus,
  SubscriptionResponse,
} from '@kinetra/shared';

import { HttpError } from '../auth/errors.js';
import type { Clock } from '../auth/service.js';
import type { SettingsRepository, SettingsSubscriptionSnapshot } from './repository.js';
import { deleteAccountSchema, notificationPreferencesSchema } from './schema.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const profileNotFound = (): HttpError =>
  new HttpError(404, 'PROFILE_NOT_FOUND', 'The authenticated user profile was not found.');

const effectiveSubscriptionStatus = (
  subscription: SettingsSubscriptionSnapshot,
  now: Date,
): Exclude<SettingsSubscriptionStatus, 'none'> => {
  if (subscription.status === 'refunded') {
    return 'cancelled';
  }

  if (subscription.status === 'active') {
    if (subscription.expiresAt !== null && subscription.expiresAt.getTime() <= now.getTime()) {
      return 'expired';
    }

    if (subscription.startsAt !== null && subscription.startsAt.getTime() > now.getTime()) {
      return 'pending';
    }
  }

  return subscription.status;
};

const daysRemaining = (expiresAt: Date | null, now: Date): number | null => {
  if (expiresAt === null) {
    return null;
  }

  return Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / MILLISECONDS_PER_DAY));
};

export class SettingsService {
  public constructor(
    private readonly repository: SettingsRepository,
    private readonly clock: Clock,
  ) {}

  public async getProfile(userId: string): Promise<SettingsProfileResponse> {
    const profile = await this.repository.findProfileByUserId(userId);

    if (profile === null) {
      throw profileNotFound();
    }

    return {
      email: profile.email,
      phone: profile.phone,
      created_at: profile.createdAt.toISOString(),
      onboarding_status: profile.onboardingStatus,
      notification_preferences: profile.notificationPreferences,
    };
  }

  public async getSubscription(userId: string): Promise<SubscriptionResponse> {
    const now = this.clock.now();
    const lookup = await this.repository.findSubscriptionByUserId(userId, now);

    if (!lookup.userExists) {
      throw profileNotFound();
    }

    const subscription = lookup.subscription;

    if (subscription === null) {
      return {
        status: 'none',
        provider: null,
        starts_at: null,
        expires_at: null,
        amount: null,
        currency: null,
        auto_renew: null,
        days_remaining: null,
      };
    }

    return {
      status: effectiveSubscriptionStatus(subscription, now),
      provider: subscription.provider,
      starts_at: subscription.startsAt?.toISOString() ?? null,
      expires_at: subscription.expiresAt?.toISOString() ?? null,
      amount: subscription.amountMinor === null ? null : subscription.amountMinor / 100,
      currency: subscription.currency,
      auto_renew: subscription.autoRenew,
      days_remaining: daysRemaining(subscription.expiresAt, now),
    };
  }

  public async updateNotifications(userId: string, body: unknown): Promise<void> {
    const parsed = notificationPreferencesSchema.safeParse(body);

    if (!parsed.success) {
      throw new HttpError(
        400,
        'INVALID_NOTIFICATION_PREFERENCES',
        parsed.error.issues[0]?.message ?? 'Notification preferences are invalid.',
      );
    }

    const updated = await this.repository.updateNotificationPreferences(
      userId,
      parsed.data satisfies NotificationPreferences,
    );

    if (!updated) {
      throw profileNotFound();
    }
  }

  public async deleteAccount(userId: string, body: unknown): Promise<void> {
    const parsed = deleteAccountSchema.safeParse(body);

    if (!parsed.success) {
      throw new HttpError(
        400,
        'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
        'Type DELETE to confirm permanent account deletion.',
      );
    }

    const deleted = await this.repository.deleteAccount(userId);

    if (!deleted) {
      throw profileNotFound();
    }
  }
}
