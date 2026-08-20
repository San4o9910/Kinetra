import type { OnboardingStatus } from '@kinetra/shared';
import type { Pool, QueryResultRow } from 'pg';

import type {
  BaseLessonSnapshot,
  BaseLessonsRepository,
  CompleteBaseProgramResult,
  LessonProgressInput,
  LessonProgressSnapshot,
} from './repository.js';

interface BaseLessonRow extends QueryResultRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly duration_seconds: number;
  readonly order_index: number;
  readonly storage_key: string | null;
  readonly poster_key: string | null;
  readonly completion_percent: string | number;
}

interface ProgressRow extends QueryResultRow {
  readonly position_seconds: number;
  readonly completion_percent: string | number;
  readonly completed_at: Date | string | null;
}

interface UserStatusRow extends QueryResultRow {
  readonly onboarding_status: OnboardingStatus;
}

interface CompletionCountRow extends QueryResultRow {
  readonly total_completed: number;
}

const asCompletionPercent = (value: string | number): number => {
  const completionPercent = Number(value);

  if (!Number.isFinite(completionPercent)) {
    throw new Error('PostgreSQL returned an invalid completion percentage.');
  }

  return completionPercent;
};

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

const mapLesson = (row: BaseLessonRow): BaseLessonSnapshot => ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  description: row.description,
  durationSeconds: row.duration_seconds,
  orderIndex: row.order_index,
  storageKey: row.storage_key,
  posterKey: row.poster_key,
  completionPercent: asCompletionPercent(row.completion_percent),
});

const mapProgress = (row: ProgressRow): LessonProgressSnapshot => ({
  positionSeconds: row.position_seconds,
  completionPercent: asCompletionPercent(row.completion_percent),
  completedAt: row.completed_at === null ? null : asDate(row.completed_at),
});

export class PostgresBaseLessonsRepository implements BaseLessonsRepository {
  public constructor(private readonly pool: Pool) {}

  public async listForUser(userId: string): Promise<readonly BaseLessonSnapshot[]> {
    const result = await this.pool.query<BaseLessonRow>(
      `
        SELECT
          video.id,
          video.slug,
          video.title,
          video.description,
          video.duration_seconds,
          video.order_index,
          video.storage_key,
          video.poster_key,
          COALESCE(progress.completion_percent, 0) AS completion_percent
        FROM users AS authenticated_user
        CROSS JOIN videos AS video
        LEFT JOIN video_progress AS progress
          ON progress.video_id = video.id
         AND progress.user_id = authenticated_user.id
        WHERE authenticated_user.id = $1
          AND video.type = 'base_lesson'
          AND video.status = 'published'
        ORDER BY video.order_index, video.id
      `,
      [userId],
    );

    return result.rows.map(mapLesson);
  }

  public async saveProgress(
    userId: string,
    lessonId: string,
    input: LessonProgressInput,
  ): Promise<LessonProgressSnapshot | null> {
    const result = await this.pool.query<ProgressRow>(
      `
        INSERT INTO video_progress AS progress (
          user_id,
          video_id,
          position_seconds,
          completion_percent,
          completed_at
        )
        SELECT
          authenticated_user.id,
          video.id,
          $3,
          $4::numeric(5, 2),
          CASE WHEN $4::numeric(5, 2) >= 90 THEN NOW() ELSE NULL END
        FROM users AS authenticated_user
        CROSS JOIN videos AS video
        WHERE authenticated_user.id = $1
          AND video.id = $2
          AND video.type = 'base_lesson'
          AND video.status = 'published'
        ON CONFLICT (user_id, video_id) DO UPDATE SET
          position_seconds = EXCLUDED.position_seconds,
          completion_percent = GREATEST(
            progress.completion_percent,
            EXCLUDED.completion_percent
          ),
          completed_at = CASE
            WHEN GREATEST(progress.completion_percent, EXCLUDED.completion_percent) >= 90
            THEN COALESCE(progress.completed_at, NOW())
            ELSE NULL
          END
        RETURNING position_seconds, completion_percent, completed_at
      `,
      [userId, lessonId, input.positionSeconds, input.completionPercent],
    );
    const row = result.rows[0];

    return row === undefined ? null : mapProgress(row);
  }

  public async completeProgram(
    userId: string,
    threshold: number,
  ): Promise<CompleteBaseProgramResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const userResult = await client.query<UserStatusRow>(
        `
          SELECT onboarding_status
          FROM users
          WHERE id = $1
          FOR UPDATE
        `,
        [userId],
      );
      const user = userResult.rows[0];

      if (user === undefined) {
        await client.query('COMMIT');
        return { kind: 'user_not_found' };
      }

      if (user.onboarding_status === 'active') {
        await client.query('COMMIT');
        return { kind: 'already_active' };
      }

      if (user.onboarding_status !== 'base_lessons') {
        await client.query('COMMIT');
        return {
          kind: 'invalid_onboarding_state',
          status: user.onboarding_status,
        };
      }

      const countResult = await client.query<CompletionCountRow>(
        `
          SELECT COUNT(*)::integer AS total_completed
          FROM video_progress AS progress
          INNER JOIN videos AS video
            ON video.id = progress.video_id
          WHERE progress.user_id = $1
            AND progress.completion_percent >= 90
            AND video.type = 'base_lesson'
            AND video.status = 'published'
        `,
        [userId],
      );
      const totalCompleted = countResult.rows[0]?.total_completed ?? 0;

      if (totalCompleted < threshold) {
        await client.query('COMMIT');
        return { kind: 'insufficient_lessons', totalCompleted };
      }

      await client.query(
        `
          UPDATE users
          SET onboarding_status = 'active',
              updated_at = NOW()
          WHERE id = $1
            AND onboarding_status = 'base_lessons'
        `,
        [userId],
      );
      await client.query('COMMIT');
      return { kind: 'activated' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
