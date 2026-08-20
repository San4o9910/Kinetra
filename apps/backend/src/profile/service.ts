import type { MeResponse } from '@kinetra/shared';

import { HttpError } from '../auth/errors.js';
import type { ProfileRepository, UserProfileSnapshot } from './repository.js';
import { surveySubmissionSchema } from './schema.js';

const profileNotFound = (): HttpError =>
  new HttpError(404, 'PROFILE_NOT_FOUND', 'The authenticated user profile was not found.');

const toIsoString = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

const toResponse = (profile: UserProfileSnapshot): MeResponse => ({
  user: {
    id: profile.id,
    email: profile.email,
    phone: profile.phone,
    emailVerified: profile.emailVerified,
    avatarUrl: profile.avatarUrl,
    username: profile.username,
    firstName: profile.firstName,
    onboardingStatus: profile.onboardingStatus,
    notificationEnabled: profile.notificationEnabled,
    level: profile.level,
    timezone: profile.timezone,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  },
  survey:
    profile.survey === null
      ? null
      : {
          id: profile.survey.id,
          version: profile.survey.version,
          gender: profile.survey.gender,
          age_range: profile.survey.ageRange,
          goal: profile.survey.goal,
          injuries: [...profile.survey.injuries],
          injuries_detail: profile.survey.injuriesDetail,
          experience: profile.survey.experience,
          is_current: profile.survey.isCurrent,
          created_at: profile.survey.createdAt.toISOString(),
        },
  subscription:
    profile.subscription === null
      ? {
          provider: null,
          status: 'none',
          isActive: false,
          startsAt: null,
          expiresAt: null,
          amountMinor: null,
          currency: null,
        }
      : {
          provider: profile.subscription.provider,
          status: profile.subscription.status,
          isActive: profile.subscription.isActive,
          startsAt: toIsoString(profile.subscription.startsAt),
          expiresAt: toIsoString(profile.subscription.expiresAt),
          amountMinor: profile.subscription.amountMinor,
          currency: profile.subscription.currency,
        },
});

export class ProfileService {
  public constructor(private readonly repository: ProfileRepository) {}

  public async getProfile(userId: string): Promise<MeResponse> {
    const profile = await this.repository.findByUserId(userId);

    if (profile === null) {
      throw profileNotFound();
    }

    return toResponse(profile);
  }

  public async saveSurvey(userId: string, body: unknown): Promise<MeResponse> {
    const parsed = surveySubmissionSchema.safeParse(body);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new HttpError(
        400,
        'INVALID_SURVEY',
        firstIssue?.message ?? 'Survey answers are invalid.',
      );
    }

    const survey = parsed.data;
    const profile = await this.repository.saveSurveyVersion(userId, {
      gender: survey.gender,
      ageRange: survey.age_range,
      goal: survey.goal,
      injuries: survey.injuries,
      injuriesDetail: survey.injuries_detail ?? null,
      experience: survey.experience,
    });

    if (profile === null) {
      throw profileNotFound();
    }

    return toResponse(profile);
  }
}
