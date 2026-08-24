import type { NotificationPreferences, OnboardingStatus } from '@kinetra/shared';

import type {
  SettingsProfileSnapshot,
  SettingsRepository,
  SettingsSubscriptionLookup,
  SettingsSubscriptionSnapshot,
} from '../../src/settings/repository.js';

const clonePreferences = (preferences: NotificationPreferences): NotificationPreferences => ({
  ...preferences,
});

export class InMemorySettingsRepository implements SettingsRepository {
  private deleted = false;
  private trainerManaged = false;
  private preferences: NotificationPreferences = {
    workout_reminders: true,
    reminder_time: '09:00',
    weekly_survey_reminder: true,
  };

  public constructor(
    private readonly userId: string,
    private readonly subscription: SettingsSubscriptionSnapshot | null = null,
    private readonly onboardingStatus: OnboardingStatus = 'active',
  ) {}

  public async findProfileByUserId(userId: string): Promise<SettingsProfileSnapshot | null> {
    if (this.deleted || userId !== this.userId) {
      return null;
    }

    return {
      email: 'athlete@example.com',
      phone: null,
      createdAt: new Date('2026-01-10T10:00:00.000Z'),
      onboardingStatus: this.onboardingStatus,
      notificationPreferences: clonePreferences(this.preferences),
    };
  }

  public async findSubscriptionByUserId(
    userId: string,
    _now: Date,
  ): Promise<SettingsSubscriptionLookup> {
    if (this.deleted || userId !== this.userId) {
      return { userExists: false, subscription: null };
    }

    return {
      userExists: true,
      subscription:
        this.subscription === null
          ? null
          : {
              ...this.subscription,
              startsAt:
                this.subscription.startsAt === null
                  ? null
                  : new Date(this.subscription.startsAt.getTime()),
              expiresAt:
                this.subscription.expiresAt === null
                  ? null
                  : new Date(this.subscription.expiresAt.getTime()),
            },
    };
  }

  public async updateNotificationPreferences(
    userId: string,
    preferences: NotificationPreferences,
  ): Promise<boolean> {
    if (this.deleted || userId !== this.userId) {
      return false;
    }

    this.preferences = clonePreferences(preferences);
    return true;
  }

  public async deleteAccount(userId: string): Promise<'deleted' | 'not_found' | 'trainer_managed'> {
    if (this.deleted || userId !== this.userId) {
      return 'not_found';
    }

    if (this.trainerManaged) {
      return 'trainer_managed';
    }

    this.deleted = true;
    return 'deleted';
  }

  public peekPreferences(): NotificationPreferences {
    return clonePreferences(this.preferences);
  }

  public isDeleted(): boolean {
    return this.deleted;
  }

  public setTrainerManaged(managed: boolean): void {
    this.trainerManaged = managed;
  }
}
