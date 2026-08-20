import type { OnboardingStatus, SubscriptionStatus } from '@kinetra/shared';
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
          id,
          email,
          phone,
          email_verified,
          avatar_url,
          username,
          first_name,
          onboarding_status,
          notification_enabled,
          level,
          timezone,
          created_at,
          updated_at
        FROM users
        WHERE id = $1
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
      survey: survey === undefined ? null : mapSurvey(survey),
      subscription: subscription === undefined ? null : mapSubscription(subscription),
    };
  }
}
