import type {
  NotificationPreferences,
  OnboardingStatus,
  SubscriptionProvider,
  SubscriptionStatus,
} from '@kinetra/shared';

export interface SettingsProfileSnapshot {
  readonly email: string | null;
  readonly phone: string | null;
  readonly createdAt: Date;
  readonly onboardingStatus: OnboardingStatus;
  readonly notificationPreferences: NotificationPreferences;
}

export interface SettingsSubscriptionSnapshot {
  readonly provider: SubscriptionProvider;
  readonly status: SubscriptionStatus;
  readonly startsAt: Date | null;
  readonly expiresAt: Date | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly autoRenew: boolean;
}

export interface SettingsSubscriptionLookup {
  readonly userExists: boolean;
  readonly subscription: SettingsSubscriptionSnapshot | null;
}

export interface SettingsRepository {
  findProfileByUserId(userId: string): Promise<SettingsProfileSnapshot | null>;
  findSubscriptionByUserId(userId: string, now: Date): Promise<SettingsSubscriptionLookup>;
  updateNotificationPreferences(
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<boolean>;
  deleteAccount(userId: string): Promise<boolean>;
}
