import type {
  OnboardingStatus,
  RequestedRole,
  SubscriptionStatus,
  TrainerVerificationState,
} from '@kinetra/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  ProfileRepository,
  SubscriptionSnapshot,
  SurveyInput,
  SurveySnapshot,
  UserProfileSnapshot,
} from './repository.js';

interface UserRow extends QueryResultRow {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly email_verified: boolean;
  readonly avatar_url: string | null;
  readonly username: string | null;
  readonly first_name: string | null;
  readonly onboarding_status: OnboardingStatus;
  readonly notification_enabled: boolean;
  readonly level: 'beginner' | 'intermediate' | 'advanced';
  readonly timezone: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly account_role: 'client' | 'trainer';
  readonly requested_role: RequestedRole;
  readonly trainer_verification_state: TrainerVerificationState;
  readonly trainer_display_name: string | null;
  readonly trainer_can_manage_videos: boolean | null;
}

interface OnboardingRow extends QueryResultRow {
  readonly onboarding_status: OnboardingStatus;
}

interface SurveyRow extends QueryResultRow {
  readonly id: string;
  readonly version: number;
  readonly gender: SurveySnapshot['gender'];
  readonly age_range: SurveySnapshot['ageRange'];
  readonly goal: SurveySnapshot['goal'];
  readonly injuries: SurveySnapshot['injuries'];
  readonly injuries_detail: string | null;
  readonly experience: SurveySnapshot['experience'];
  readonly is_current: boolean;
  readonly created_at: Date;
}

interface SubscriptionRow extends QueryResultRow {
  readonly provider: SubscriptionSnapshot['provider'];
  readonly effective_status: SubscriptionStatus;
  readonly is_active: boolean;
  readonly starts_at: Date | null;
  readonly expires_at: Date | null;
  readonly amount_minor: number | null;
  readonly currency: string | null;
}

interface VersionRow extends QueryResultRow {
  readonly next_version: number;
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

const mapSurvey = (row: SurveyRow): SurveySnapshot => ({
  id: row.id,
  version: row.version,
  gender: row.gender,
  ageRange: row.age_range,
  goal: row.goal,
  injuries: [...row.injuries],
  injuriesDetail: row.injuries_detail,
  experience: row.experience,
  isCurrent: row.is_current,
  createdAt: asDate(row.created_at),
});

const mapSubscription = (row: SubscriptionRow): SubscriptionSnapshot => ({
  provider: row.provider,
  status: row.effective_status,
  isActive: row.is_active,
  startsAt: row.starts_at === null ? null : asDate(row.starts_at),
  expiresAt: row.expires_at === null ? null : asDate(row.expires_at),
  amountMinor: row.amount_minor,
  currency: row.currency,
});

export class PostgresProfileRepository implements ProfileRepository {
  public constructor(private readonly pool: Pool) {}

  public async findByUserId(userId: string): Promise<UserProfileSnapshot | null> {
    const client = await this.pool.connect();

    try {
      return await this.loadProfile(client, userId);
    } finally {
      client.release();
    }
  }

  public async saveSurveyVersion(
    userId: string,
    input: SurveyInput,
  ): Promise<UserProfileSnapshot | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const user = await client.query<OnboardingRow>(
        `
          SELECT onboarding_status
          FROM users
          WHERE id = $1
          FOR UPDATE
        `,
        [userId],
      );

      if (user.rowCount !== 1) {
        await client.query('ROLLBACK');
        return null;
      }

      const versionResult = await client.query<VersionRow>(
        `
          SELECT (COALESCE(MAX(version), 0) + 1)::integer AS next_version
          FROM survey_answers
          WHERE user_id = $1
        `,
        [userId],
      );
      const nextVersion = versionResult.rows[0]?.next_version;

      if (nextVersion === undefined) {
        throw new Error('Could not determine the next survey version.');
      }

      await client.query(
        `
          UPDATE survey_answers
          SET is_current = false,
              updated_at = NOW()
          WHERE user_id = $1
            AND is_current = true
        `,
        [userId],
      );

      await client.query(
        `
          INSERT INTO survey_answers (
            user_id,
            version,
            gender,
            age_range,
            goal,
            injuries,
            injuries_detail,
            experience,
            is_current
          )
          VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, true)
        `,
        [
          userId,
          nextVersion,
          input.gender,
          input.ageRange,
          input.goal,
          [...input.injuries],
          input.injuriesDetail,
          input.experience,
        ],
      );

      await client.query(
        `
          UPDATE users
          SET onboarding_status = CASE
                WHEN onboarding_status = 'survey_pending' THEN 'onboarding_pending'
                ELSE onboarding_status
              END,
              updated_at = NOW()
          WHERE id = $1
        `,
        [userId],
      );

      const profile = await this.loadProfile(client, userId);
      await client.query('COMMIT');
      return profile;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async completeOnboarding(userId: string): Promise<UserProfileSnapshot | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const user = await client.query<OnboardingRow>(
        `
          SELECT onboarding_status
          FROM users
          WHERE id = $1
          FOR UPDATE
        `,
        [userId],
      );

      if (user.rowCount !== 1) {
        await client.query('ROLLBACK');
        return null;
      }

      if (user.rows[0]?.onboarding_status === 'onboarding_pending') {
        await client.query(
          `
            UPDATE users
            SET onboarding_status = 'base_lessons',
                updated_at = NOW()
            WHERE id = $1
          `,
          [userId],
        );
      }

      const profile = await this.loadProfile(client, userId);
      await client.query('COMMIT');
      return profile;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadProfile(
    client: PoolClient,
    userId: string,
  ): Promise<UserProfileSnapshot | null> {
    const userResult = await client.query<UserRow>(
      `
        SELECT
          user_record.id,
          user_record.email,
          user_record.phone,
          user_record.email_verified,
          user_record.avatar_url,
          user_record.username,
          user_record.first_name,
          user_record.onboarding_status,
          user_record.notification_enabled,
          user_record.level,
          user_record.timezone,
          user_record.created_at,
          user_record.updated_at,
          CASE WHEN trainer.user_id IS NULL THEN 'client' ELSE 'trainer' END AS account_role,
          user_record.requested_role,
          CASE
            WHEN user_record.requested_role <> 'trainer' THEN 'not_started'
            WHEN trainer.user_id IS NOT NULL THEN 'approved'
            WHEN verification_request.id IS NULL THEN 'not_started'
            WHEN verification_request.status = 'pending'
              AND verification_request.submitted_at IS NULL
            THEN 'not_started'
            ELSE verification_request.status
          END AS trainer_verification_state,
          trainer.display_name AS trainer_display_name,
          trainer.can_manage_videos AS trainer_can_manage_videos
        FROM users AS user_record
        LEFT JOIN trainer_profiles AS trainer
         ON trainer.user_id = user_record.id
         AND trainer.is_active = true
        LEFT JOIN LATERAL (
          SELECT request.id, request.status, request.submitted_at
          FROM trainer_verification_requests AS request
          WHERE request.user_id = user_record.id
          ORDER BY
            (request.status IN ('pending', 'needs_more_info', 'approved')) DESC,
            request.created_at DESC,
            request.updated_at DESC,
            request.id DESC
          LIMIT 1
        ) AS verification_request ON true
        WHERE user_record.id = $1
      `,
      [userId],
    );
    const user = userResult.rows[0];

    if (user === undefined) {
      return null;
    }

    const [surveyResult, subscriptionResult] = await Promise.all([
      client.query<SurveyRow>(
        `
          SELECT
            id,
            version,
            gender,
            age_range,
            goal,
            injuries,
            injuries_detail,
            experience,
            is_current,
            created_at
          FROM survey_answers
          WHERE user_id = $1
            AND is_current = true
          LIMIT 1
        `,
        [userId],
      ),
      client.query<SubscriptionRow>(
        `
          SELECT
            provider,
            CASE
              WHEN status = 'active'
                AND expires_at IS NOT NULL
                AND expires_at <= NOW()
              THEN 'expired'
              ELSE status
            END AS effective_status,
            (
              status = 'active'
              AND (starts_at IS NULL OR starts_at <= NOW())
              AND (expires_at IS NULL OR expires_at > NOW())
            ) AS is_active,
            starts_at,
            expires_at,
            amount_minor,
            currency
          FROM subscriptions
          WHERE user_id = $1
          ORDER BY
            (
              status = 'active'
              AND (starts_at IS NULL OR starts_at <= NOW())
              AND (expires_at IS NULL OR expires_at > NOW())
            ) DESC,
            created_at DESC
          LIMIT 1
        `,
        [userId],
      ),
    ]);

    const survey = surveyResult.rows[0];
    const subscription = subscriptionResult.rows[0];

    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      emailVerified: user.email_verified,
      avatarUrl: user.avatar_url,
      username: user.username,
      firstName: user.first_name,
      onboardingStatus: user.onboarding_status,
      notificationEnabled: user.notification_enabled,
      level: user.level,
      timezone: user.timezone,
      createdAt: asDate(user.created_at),
      updatedAt: asDate(user.updated_at),
      accountRole: user.account_role,
      requestedRole: user.requested_role,
      trainerVerificationState: user.trainer_verification_state,
      trainerProfile:
        user.account_role === 'trainer' && user.trainer_display_name !== null
          ? {
              displayName: user.trainer_display_name,
              avatarUrl: user.avatar_url,
              canManageVideos: user.trainer_can_manage_videos === true,
            }
          : null,
      survey: survey === undefined ? null : mapSurvey(survey),
      subscription: subscription === undefined ? null : mapSubscription(subscription),
    };
  }
}
