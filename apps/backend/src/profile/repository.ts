import type {
  OnboardingStatus,
  SubscriptionProvider,
  SubscriptionStatus,
  SurveyAgeRange,
  SurveyExperience,
  SurveyGender,
  SurveyGoal,
  SurveyInjury,
} from '@kinetra/shared';

export interface SurveyInput {
  readonly gender: SurveyGender;
  readonly ageRange: SurveyAgeRange;
  readonly goal: SurveyGoal;
  readonly injuries: readonly SurveyInjury[];
  readonly injuriesDetail: string | null;
  readonly experience: SurveyExperience;
}

export interface SurveySnapshot extends SurveyInput {
  readonly id: string;
  readonly version: number;
  readonly isCurrent: boolean;
  readonly createdAt: Date;
}

export interface SubscriptionSnapshot {
  readonly provider: SubscriptionProvider;
  readonly status: SubscriptionStatus;
  readonly isActive: boolean;
  readonly startsAt: Date | null;
  readonly expiresAt: Date | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
}

export interface UserProfileSnapshot {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly emailVerified: boolean;
  readonly avatarUrl: string | null;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly onboardingStatus: OnboardingStatus;
  readonly notificationEnabled: boolean;
  readonly level: 'beginner' | 'intermediate' | 'advanced';
  readonly timezone: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly survey: SurveySnapshot | null;
  readonly subscription: SubscriptionSnapshot | null;
}

export interface ProfileRepository {
  findByUserId(userId: string): Promise<UserProfileSnapshot | null>;
  saveSurveyVersion(userId: string, input: SurveyInput): Promise<UserProfileSnapshot | null>;
}
