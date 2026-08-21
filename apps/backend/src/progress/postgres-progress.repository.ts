import type { SurveyGoal } from '@kinetra/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  AchievementRuleType,
  AchievementSnapshot,
  ProgressDashboardSnapshot,
  ProgressRepository,
  ProgressStatsSnapshot,
  ProgressSurveySnapshot,
  WeeklyMetricInput,
  WeeklyMetricSnapshot,
} from './repository.js';

interface SurveyRow extends QueryResultRow {
  readonly goal: ProgressSurveySnapshot['goal'];
  readonly gender: ProgressSurveySnapshot['gender'];
  readonly age_range: ProgressSurveySnapshot['ageRange'];
  readonly experience: ProgressSurveySnapshot['experience'];
  readonly injuries: ProgressSurveySnapshot['injuries'];
  readonly injuries_detail: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface CurrentSurveyRow extends SurveyRow {
  readonly version: number;
}

interface NextVersionRow extends QueryResultRow {
  readonly next_version: number;
}

interface MetricRow extends QueryResultRow {
  readonly program_week: number;
  readonly energy: number;
  readonly sleep: number;
  readonly mood: number;
  readonly body_satisfaction: number;
  readonly note: string | null;
  readonly created_at: Date | string;
}

interface StatsRow extends QueryResultRow {
  readonly total_workouts: number;
  readonly total_weeks_completed: number;
  readonly current_streak: number;
  readonly best_streak: number;
  readonly total_minutes_trained: number;
}

interface AchievementRow extends QueryResultRow {
  readonly code: string;
  readonly title: string;
  readonly description: string | null;
  readonly icon_key: string;
  readonly rule_type: string;
  readonly rule_value: number;
  readonly current_value: number;
  readonly unlocked_at: Date | string | null;
}

const achievementRuleTypes = new Set<AchievementRuleType>([
  'base_lessons_viewed',
  'workouts_completed',
  'week_days_completed',
  'workout_streak',
]);

const dateFrom = (value: Date | string, label: string): Date => {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }

  return date;
};

const integerFrom = (value: number | string, label: string): number => {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }

  return parsed;
};

const ruleTypeFrom = (value: string): AchievementRuleType => {
  if (!achievementRuleTypes.has(value as AchievementRuleType)) {
    throw new Error(`PostgreSQL returned an unsupported achievement rule type: ${value}.`);
  }

  return value as AchievementRuleType;
};

const mapSurvey = (row: SurveyRow): ProgressSurveySnapshot => ({
  goal: row.goal,
  gender: row.gender,
  ageRange: row.age_range,
  experience: row.experience,
  injuries: [...row.injuries],
  injuriesDetail: row.injuries_detail,
  createdAt: dateFrom(row.created_at, 'survey creation timestamp'),
  updatedAt: dateFrom(row.updated_at, 'survey update timestamp'),
});

const mapMetric = (row: MetricRow): WeeklyMetricSnapshot => ({
  programWeek: integerFrom(row.program_week, 'weekly metric program week'),
  energy: integerFrom(row.energy, 'weekly energy score'),
  sleep: integerFrom(row.sleep, 'weekly sleep score'),
  mood: integerFrom(row.mood, 'weekly mood score'),
  bodySatisfaction: integerFrom(row.body_satisfaction, 'weekly body satisfaction score'),
  note: row.note,
  createdAt: dateFrom(row.created_at, 'weekly metric creation timestamp'),
});

const mapStats = (row: StatsRow | undefined): ProgressStatsSnapshot => {
  if (row === undefined) {
    throw new Error('PostgreSQL did not return progress statistics.');
  }

  return {
    totalWorkouts: integerFrom(row.total_workouts, 'total workout count'),
    totalWeeksCompleted: integerFrom(row.total_weeks_completed, 'completed week count'),
    currentStreak: integerFrom(row.current_streak, 'current workout streak'),
    bestStreak: integerFrom(row.best_streak, 'best workout streak'),
    totalMinutesTrained: integerFrom(row.total_minutes_trained, 'total trained minutes'),
  };
};

const mapAchievement = (row: AchievementRow): AchievementSnapshot => ({
  code: row.code,
  title: row.title,
  description: row.description,
  iconKey: row.icon_key,
  ruleType: ruleTypeFrom(row.rule_type),
  ruleValue: integerFrom(row.rule_value, 'achievement rule target'),
  currentValue: integerFrom(row.current_value, 'achievement progress'),
  unlockedAt:
    row.unlocked_at === null ? null : dateFrom(row.unlocked_at, 'achievement unlock timestamp'),
});

const surveySql = `
  SELECT
    goal,
    gender,
    age_range,
    experience,
    injuries,
    injuries_detail,
    created_at,
    updated_at
  FROM survey_answers
  WHERE user_id = $1
    AND is_current = true
  LIMIT 1
`;

const metricsSql = `
  SELECT
    program_week,
    energy,
    sleep,
    mood,
    body_satisfaction,
    note,
    created_at
  FROM weekly_metrics
  WHERE user_id = $1
  ORDER BY program_week
`;

const achievementFactsCte = `
  WITH valid_workouts AS (
    SELECT
      completion.id AS completion_id,
      completion.program_week,
      completion.workout_date,
      completion.completed_at,
      video.day_of_week
    FROM workout_completions AS completion
    INNER JOIN videos AS video
      ON video.id = completion.video_id
     AND video.type = 'workout'
     AND video.status = 'published'
     AND video.week_number = completion.program_week
    WHERE completion.user_id = $1
      AND completion.workout_date <= CURRENT_DATE
  ),
  ranked_workouts AS (
    SELECT
      completed_at,
      ROW_NUMBER() OVER (ORDER BY completed_at, completion_id) AS event_rank
    FROM valid_workouts
  ),
  ranked_base_lessons AS (
    SELECT
      COALESCE(progress.completed_at, progress.updated_at) AS completed_at,
      ROW_NUMBER() OVER (
        ORDER BY COALESCE(progress.completed_at, progress.updated_at), progress.video_id
      ) AS event_rank
    FROM video_progress AS progress
    INNER JOIN videos AS video
      ON video.id = progress.video_id
     AND video.type = 'base_lesson'
     AND video.status = 'published'
    WHERE progress.user_id = $1
      AND progress.completion_percent >= 90
  ),
  week_day_events AS (
    SELECT
      program_week,
      day_of_week,
      MIN(completed_at) AS completed_at
    FROM valid_workouts
    GROUP BY program_week, day_of_week
  ),
  ranked_week_days AS (
    SELECT
      completed_at,
      ROW_NUMBER() OVER (
        PARTITION BY program_week
        ORDER BY completed_at, day_of_week
      ) AS event_rank
    FROM week_day_events
  ),
  week_counts AS (
    SELECT COUNT(DISTINCT day_of_week)::integer AS days_completed
    FROM valid_workouts
    GROUP BY program_week
  ),
  workout_dates AS (
    SELECT workout_date, MIN(completed_at) AS completed_at
    FROM valid_workouts
    GROUP BY workout_date
  ),
  numbered_dates AS (
    SELECT
      workout_date,
      completed_at,
      workout_date - ROW_NUMBER() OVER (ORDER BY workout_date)::integer AS streak_group
    FROM workout_dates
  ),
  ranked_streak_dates AS (
    SELECT
      completed_at,
      ROW_NUMBER() OVER (
        PARTITION BY streak_group
        ORDER BY workout_date
      ) AS event_rank
    FROM numbered_dates
  ),
  streaks AS (
    SELECT COUNT(*)::integer AS streak_length
    FROM numbered_dates
    GROUP BY streak_group
  ),
  facts AS (
    SELECT
      (
        SELECT COUNT(DISTINCT progress.video_id)::integer
        FROM video_progress AS progress
        INNER JOIN videos AS video
          ON video.id = progress.video_id
         AND video.type = 'base_lesson'
         AND video.status = 'published'
        WHERE progress.user_id = $1
          AND progress.completion_percent >= 90
      ) AS base_lessons_viewed,
      (SELECT COUNT(*)::integer FROM valid_workouts) AS workouts_completed,
      COALESCE((SELECT MAX(days_completed) FROM week_counts), 0)::integer
        AS week_days_completed,
      COALESCE((SELECT MAX(streak_length) FROM streaks), 0)::integer AS workout_streak
  )
`;

export class PostgresProgressRepository implements ProgressRepository {
  public constructor(private readonly pool: Pool) {}

  public async getDashboard(userId: string): Promise<ProgressDashboardSnapshot | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const surveyResult = await client.query<SurveyRow>(surveySql, [userId]);
      const survey = surveyResult.rows[0];

      if (survey === undefined) {
        await client.query('COMMIT');
        return null;
      }

      const stats = await this.loadStats(client, userId);
      await this.materializeAchievements(client, userId);
      const metrics = await this.loadMetrics(client, userId);
      const achievements = await this.loadAchievements(client, userId);
      await client.query('COMMIT');

      return {
        survey: mapSurvey(survey),
        metrics,
        achievements,
        stats,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async getMetrics(userId: string): Promise<readonly WeeklyMetricSnapshot[] | null> {
    const client = await this.pool.connect();

    try {
      const user = await client.query('SELECT id FROM users WHERE id = $1', [userId]);

      if (user.rowCount !== 1) {
        return null;
      }

      return this.loadMetrics(client, userId);
    } finally {
      client.release();
    }
  }

  public async upsertWeeklyMetrics(userId: string, input: WeeklyMetricInput): Promise<boolean> {
    const result = await this.pool.query(
      `
        INSERT INTO weekly_metrics (
          user_id,
          program_week,
          energy,
          sleep,
          mood,
          body_satisfaction,
          note
        )
        SELECT id, $2, $3, $4, $5, $6, $7
        FROM users
        WHERE id = $1
        ON CONFLICT ON CONSTRAINT weekly_metrics_user_week_unique
        DO UPDATE SET
          energy = EXCLUDED.energy,
          sleep = EXCLUDED.sleep,
          mood = EXCLUDED.mood,
          body_satisfaction = EXCLUDED.body_satisfaction,
          note = EXCLUDED.note
        RETURNING id
      `,
      [
        userId,
        input.programWeek,
        input.energy,
        input.sleep,
        input.mood,
        input.bodySatisfaction,
        input.note,
      ],
    );

    return result.rowCount === 1;
  }

  public async updateGoalVersion(
    userId: string,
    goal: SurveyGoal,
  ): Promise<ProgressSurveySnapshot | null> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);

      if (user.rowCount !== 1) {
        await client.query('ROLLBACK');
        return null;
      }

      const currentResult = await client.query<CurrentSurveyRow>(
        `
          SELECT
            version,
            goal,
            gender,
            age_range,
            experience,
            injuries,
            injuries_detail,
            created_at,
            updated_at
          FROM survey_answers
          WHERE user_id = $1
            AND is_current = true
          FOR UPDATE
        `,
        [userId],
      );
      const current = currentResult.rows[0];

      if (current === undefined) {
        await client.query('ROLLBACK');
        return null;
      }

      const versionResult = await client.query<NextVersionRow>(
        `
          SELECT (COALESCE(MAX(version), 0) + 1)::integer AS next_version
          FROM survey_answers
          WHERE user_id = $1
        `,
        [userId],
      );
      const nextVersion = versionResult.rows[0]?.next_version;

      if (nextVersion === undefined) {
        throw new Error('Could not determine the next survey version for a goal update.');
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

      const inserted = await client.query<SurveyRow>(
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
          RETURNING
            goal,
            gender,
            age_range,
            experience,
            injuries,
            injuries_detail,
            created_at,
            updated_at
        `,
        [
          userId,
          nextVersion,
          current.gender,
          current.age_range,
          goal,
          [...current.injuries],
          current.injuries_detail,
          current.experience,
        ],
      );
      const survey = inserted.rows[0];

      if (survey === undefined) {
        throw new Error('PostgreSQL did not return the updated goal survey version.');
      }

      await client.query('COMMIT');
      return mapSurvey(survey);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadMetrics(
    client: PoolClient,
    userId: string,
  ): Promise<readonly WeeklyMetricSnapshot[]> {
    const result = await client.query<MetricRow>(metricsSql, [userId]);
    return result.rows.map(mapMetric);
  }

  private async loadStats(client: PoolClient, userId: string): Promise<ProgressStatsSnapshot> {
    const result = await client.query<StatsRow>(
      `
        WITH valid_workouts AS (
          SELECT
            completion.program_week,
            completion.workout_date,
            video.day_of_week,
            video.duration_seconds
          FROM workout_completions AS completion
          INNER JOIN videos AS video
            ON video.id = completion.video_id
           AND video.type = 'workout'
           AND video.status = 'published'
           AND video.week_number = completion.program_week
          WHERE completion.user_id = $1
            AND completion.workout_date <= CURRENT_DATE
        ),
        week_counts AS (
          SELECT
            program_week,
            COUNT(DISTINCT day_of_week)::integer AS days_completed
          FROM valid_workouts
          GROUP BY program_week
        ),
        workout_dates AS (
          SELECT DISTINCT workout_date
          FROM valid_workouts
        ),
        numbered_dates AS (
          SELECT
            workout_date,
            workout_date - ROW_NUMBER() OVER (ORDER BY workout_date)::integer AS streak_group
          FROM workout_dates
        ),
        streaks AS (
          SELECT
            COUNT(*)::integer AS streak_length,
            MAX(workout_date) AS streak_end
          FROM numbered_dates
          GROUP BY streak_group
        ),
        latest AS (
          SELECT MAX(workout_date) AS latest_date
          FROM workout_dates
        )
        SELECT
          (SELECT COUNT(*)::integer FROM valid_workouts) AS total_workouts,
          (
            SELECT COUNT(*)::integer
            FROM week_counts
            WHERE days_completed >= 7
          ) AS total_weeks_completed,
          CASE
            WHEN latest.latest_date >= CURRENT_DATE - 1
            THEN COALESCE(
              (
                SELECT streak_length
                FROM streaks
                WHERE streak_end = latest.latest_date
                LIMIT 1
              ),
              0
            )
            ELSE 0
          END::integer AS current_streak,
          COALESCE((SELECT MAX(streak_length) FROM streaks), 0)::integer AS best_streak,
          FLOOR(
            COALESCE((SELECT SUM(duration_seconds) FROM valid_workouts), 0) / 60.0
          )::integer AS total_minutes_trained
        FROM latest
      `,
      [userId],
    );

    return mapStats(result.rows[0]);
  }

  private async materializeAchievements(client: PoolClient, userId: string): Promise<void> {
    await client.query(
      `${achievementFactsCte}
        , eligible_achievements AS (
          SELECT
            achievement.id,
            CASE achievement.rule_type
              WHEN 'base_lessons_viewed' THEN (
                SELECT completed_at
                FROM ranked_base_lessons
                WHERE event_rank = achievement.rule_value
                LIMIT 1
              )
              WHEN 'workouts_completed' THEN (
                SELECT completed_at
                FROM ranked_workouts
                WHERE event_rank = achievement.rule_value
                LIMIT 1
              )
              WHEN 'week_days_completed' THEN (
                SELECT MIN(completed_at)
                FROM ranked_week_days
                WHERE event_rank = achievement.rule_value
              )
              WHEN 'workout_streak' THEN (
                SELECT MIN(completed_at)
                FROM ranked_streak_dates
                WHERE event_rank = achievement.rule_value
              )
              ELSE NULL
            END AS unlocked_at
          FROM achievements AS achievement
          CROSS JOIN facts
          WHERE achievement.code IN (
              'first_base_lesson',
              'base_unlocked',
              'first_workout',
              'week_complete',
              'streak_3'
            )
            AND CASE achievement.rule_type
              WHEN 'base_lessons_viewed'
                THEN facts.base_lessons_viewed >= achievement.rule_value
              WHEN 'workouts_completed'
                THEN facts.workouts_completed >= achievement.rule_value
              WHEN 'week_days_completed'
                THEN facts.week_days_completed >= achievement.rule_value
              WHEN 'workout_streak'
                THEN facts.workout_streak >= achievement.rule_value
              ELSE false
            END
        )
        INSERT INTO user_achievements (user_id, achievement_id, unlocked_at)
        SELECT $1, achievement.id, achievement.unlocked_at
        FROM eligible_achievements AS achievement
        WHERE EXISTS(SELECT 1 FROM users WHERE id = $1)
          AND achievement.unlocked_at IS NOT NULL
        ON CONFLICT (user_id, achievement_id) DO NOTHING
      `,
      [userId],
    );
  }

  private async loadAchievements(
    client: PoolClient,
    userId: string,
  ): Promise<readonly AchievementSnapshot[]> {
    const result = await client.query<AchievementRow>(
      `${achievementFactsCte}
        SELECT
          achievement.code,
          achievement.title,
          achievement.description,
          achievement.icon_key,
          achievement.rule_type,
          achievement.rule_value,
          CASE achievement.rule_type
            WHEN 'base_lessons_viewed' THEN facts.base_lessons_viewed
            WHEN 'workouts_completed' THEN facts.workouts_completed
            WHEN 'week_days_completed' THEN facts.week_days_completed
            WHEN 'workout_streak' THEN facts.workout_streak
            ELSE 0
          END::integer AS current_value,
          unlocked.unlocked_at
        FROM achievements AS achievement
        CROSS JOIN facts
        LEFT JOIN user_achievements AS unlocked
          ON unlocked.user_id = $1
         AND unlocked.achievement_id = achievement.id
        WHERE achievement.code IN (
          'first_base_lesson',
          'base_unlocked',
          'first_workout',
          'week_complete',
          'streak_3'
        )
        ORDER BY CASE achievement.code
          WHEN 'first_base_lesson' THEN 1
          WHEN 'base_unlocked' THEN 2
          WHEN 'first_workout' THEN 3
          WHEN 'week_complete' THEN 4
          WHEN 'streak_3' THEN 5
          ELSE 100
        END,
        achievement.code
      `,
      [userId],
    );

    return result.rows.map(mapAchievement);
  }
}
