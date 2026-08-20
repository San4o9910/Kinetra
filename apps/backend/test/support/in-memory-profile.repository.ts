import type { OnboardingStatus } from '@kinetra/shared';

import type {
  ProfileRepository,
  SubscriptionSnapshot,
  SurveyInput,
  SurveySnapshot,
  UserProfileSnapshot,
} from '../../src/profile/repository.js';

export class InMemoryProfileRepository implements ProfileRepository {
  private readonly surveys: SurveySnapshot[] = [];
  private onboardingStatus: OnboardingStatus = 'survey_pending';

  public constructor(
    private readonly userId: string,
    private readonly subscription: SubscriptionSnapshot | null = null,
  ) {}

  public async findByUserId(userId: string): Promise<UserProfileSnapshot | null> {
    if (userId !== this.userId) {
      return null;
    }

    return this.snapshot();
  }

  public async saveSurveyVersion(
    userId: string,
    input: SurveyInput,
  ): Promise<UserProfileSnapshot | null> {
    if (userId !== this.userId) {
      return null;
    }

    for (const [index, survey] of this.surveys.entries()) {
      if (survey.isCurrent) {
        this.surveys[index] = {
          ...survey,
          isCurrent: false,
        };
      }
    }

    this.surveys.push({
      id: `survey-${this.surveys.length + 1}`,
      version: this.surveys.length + 1,
      gender: input.gender,
      ageRange: input.ageRange,
      goal: input.goal,
      injuries: [...input.injuries],
      injuriesDetail: input.injuriesDetail,
      experience: input.experience,
      isCurrent: true,
      createdAt: new Date(
        `2026-08-${String(20 + this.surveys.length).padStart(2, '0')}T00:00:00.000Z`,
      ),
    });

    if (this.onboardingStatus === 'survey_pending') {
      this.onboardingStatus = 'onboarding_pending';
    }

    return this.snapshot();
  }

  public async completeOnboarding(userId: string): Promise<UserProfileSnapshot | null> {
    if (userId !== this.userId) {
      return null;
    }

    if (this.onboardingStatus === 'onboarding_pending') {
      this.onboardingStatus = 'base_lessons';
    }

    return this.snapshot();
  }

  public setOnboardingStatus(status: OnboardingStatus): void {
    this.onboardingStatus = status;
  }

  public peekSurveyVersions(): readonly SurveySnapshot[] {
    return this.surveys.map((survey) => ({
      ...survey,
      injuries: [...survey.injuries],
    }));
  }

  private snapshot(): UserProfileSnapshot {
    const currentSurvey = this.surveys.find((survey) => survey.isCurrent) ?? null;

    return {
      id: this.userId,
      email: 'athlete@example.com',
      phone: null,
      emailVerified: true,
      avatarUrl: null,
      username: 'athlete',
      firstName: 'Алекс',
      onboardingStatus: this.onboardingStatus,
      notificationEnabled: true,
      level: 'beginner',
      timezone: 'Europe/Moscow',
      createdAt: new Date('2026-08-20T00:00:00.000Z'),
      updatedAt: new Date('2026-08-20T00:00:00.000Z'),
      survey:
        currentSurvey === null
          ? null
          : {
              ...currentSurvey,
              injuries: [...currentSurvey.injuries],
            },
      subscription: this.subscription,
    };
  }
}
