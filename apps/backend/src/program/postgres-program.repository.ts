import type { ProgramDirection } from '@kinetra/shared';
import type { Pool, QueryResultRow } from 'pg';

import {
  PROGRAM_DAYS_PER_WEEK,
  PROGRAM_WEEK_COUNT,
  type CompleteWorkoutResult,
  type ProgramDaySnapshot,
  type ProgramProgressSnapshot,
  type ProgramRepository,
  type ProgramWeekSnapshot,
} from './repository.js';

interface ProgressRow extends QueryResultRow {
  readonly user_exists: boolean;
  readonly latest_week: number;
  readonly latest_week_days_completed: number;
  readonly total_weeks: number;
  readonly weeks_completed: number;
  readonly total_workouts_done: number;
}

interface WeekRow extends QueryResultRow {
  readonly week_id: string;
  readonly week_number: number;
  readonly week_title: string;
  readonly day_id: string;
  readonly day_of_week: number;
  readonly direction: string;
  readonly day_title: string;
  readonly day_description: string | null;
  readonly duration_minutes: number;
  readonly icon: string;
  readonly video_id: string;
  readonly storage_key: string | null;
  readonly poster_key: string | null;
  readonly media_available: boolean;
  readonly completed_at: Date | string | null;
}

interface CompleteWorkoutRow extends QueryResultRow {
  readonly eligible: boolean;
  readonly inserted: boolean;
}

const integerFrom = (value: number, label: string): number => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }

  return parsed;
};

const dateFrom = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

const programDirections = new Set<ProgramDirection>([
  'breathing',
  'strength',
  'body_therapy',
  'functional',
  'stretching',
  'neuro',
  'recovery',
]);

const directionFrom = (value: string): ProgramDirection => {
  if (!programDirections.has(value as ProgramDirection)) {
    throw new Error('PostgreSQL returned an invalid program direction.');
  }

  return value as ProgramDirection;
};

const mapDay = (row: WeekRow): ProgramDaySnapshot => ({
  id: row.day_id,
  dayOfWeek: integerFrom(row.day_of_week, 'program day number'),
  direction: directionFrom(row.direction),
  title: row.day_title,
  description: row.day_description,
  durationMinutes: integerFrom(row.duration_minutes, 'program day duration'),
  icon: row.icon,
  videoId: row.video_id,
  storageKey: row.storage_key,
  posterKey: row.poster_key,
  mediaAvailable: row.media_available,
  completedAt: row.completed_at === null ? null : dateFrom(row.completed_at),
});

export class PostgresProgramRepository implements ProgramRepository {
  public constructor(private readonly pool: Pool) {}

  public async getProgress(userId: string): Promise<ProgramProgressSnapshot> {
    const result = await this.pool.query<ProgressRow>(
      `
        WITH valid_completions AS (
          SELECT
            completion.program_week,
            video.day_of_week
          FROM workout_completions AS completion
          INNER JOIN videos AS video
            ON video.id = completion.video_id
           AND video.type = 'workout'
           AND video.status = 'published'
           AND video.week_number = completion.program_week
          WHERE completion.user_id = $1
        ),
        completion_counts AS (
          SELECT
            program_week,
            COUNT(DISTINCT day_of_week)::integer AS days_completed
          FROM valid_completions
          GROUP BY program_week
        ),
        latest AS (
          SELECT COALESCE(MAX(program_week), 0)::integer AS week_number
          FROM completion_counts
        )
        SELECT
          EXISTS(SELECT 1 FROM users WHERE id = $1) AS user_exists,
          latest.week_number AS latest_week,
          COALESCE(
            (
              SELECT days_completed
              FROM completion_counts
              WHERE program_week = latest.week_number
            ),
            0
          )::integer AS latest_week_days_completed,
          (SELECT COUNT(*)::integer FROM program_weeks) AS total_weeks,
          (
            SELECT COUNT(*)::integer
            FROM completion_counts
            WHERE days_completed >= $2
          ) AS weeks_completed,
          (SELECT COUNT(*)::integer FROM valid_completions) AS total_workouts_done
        FROM latest
      `,
      [userId, PROGRAM_DAYS_PER_WEEK],
    );
    const row = result.rows[0];

    if (row === undefined || !row.user_exists) {
      return {
        currentWeekNumber: 1,
        totalWeeks: PROGRAM_WEEK_COUNT,
        weeksCompleted: 0,
        totalWorkoutsDone: 0,
      };
    }

    const latestWeek = integerFrom(row.latest_week, 'latest program week');
    const latestWeekDaysCompleted = integerFrom(
      row.latest_week_days_completed,
      'latest program week completion count',
    );
    const currentWeekNumber =
      latestWeek === 0
        ? 1
        : Math.min(
            latestWeek + (latestWeekDaysCompleted >= PROGRAM_DAYS_PER_WEEK ? 1 : 0),
            PROGRAM_WEEK_COUNT,
          );

    return {
      currentWeekNumber,
      totalWeeks: integerFrom(row.total_weeks, 'total program week count'),
      weeksCompleted: integerFrom(row.weeks_completed, 'completed program week count'),
      totalWorkoutsDone: integerFrom(row.total_workouts_done, 'completed workout count'),
    };
  }

  public async getWeek(userId: string, weekNumber: number): Promise<ProgramWeekSnapshot | null> {
    const result = await this.pool.query<WeekRow>(
      `
        SELECT
          week.id AS week_id,
          week.week_number,
          week.title AS week_title,
          day.id AS day_id,
          day.day_of_week,
          day.direction,
          day.title AS day_title,
          day.description AS day_description,
          day.duration_minutes,
          day.icon,
          video.id AS video_id,
          video.storage_key,
          video.poster_key,
          video.media_available,
          completion.completed_at
        FROM program_weeks AS week
        INNER JOIN program_days AS day
          ON day.program_week_id = week.id
        INNER JOIN videos AS video
          ON video.type = 'workout'
         AND video.status = 'published'
         AND video.week_number = week.week_number
         AND video.day_of_week = day.day_of_week
        LEFT JOIN workout_completions AS completion
          ON completion.user_id = $1
         AND completion.video_id = video.id
         AND completion.program_week = week.week_number
        WHERE week.week_number = $2
        ORDER BY day.day_of_week
      `,
      [userId, weekNumber],
    );
    const first = result.rows[0];

    if (first === undefined) {
      return null;
    }

    return {
      id: first.week_id,
      weekNumber: integerFrom(first.week_number, 'program week number'),
      title: first.week_title,
      days: result.rows.map(mapDay),
    };
  }

  public async completeWorkout(
    userId: string,
    videoId: string,
    programWeek: number,
  ): Promise<CompleteWorkoutResult> {
    const result = await this.pool.query<CompleteWorkoutRow>(
      `
        WITH eligible_workout AS (
          SELECT authenticated_user.id AS user_id, video.id AS video_id
          FROM users AS authenticated_user
          CROSS JOIN videos AS video
          WHERE authenticated_user.id = $1
            AND video.id = $2
            AND video.type = 'workout'
            AND video.status = 'published'
            AND video.week_number = $3
        ),
        inserted AS (
          INSERT INTO workout_completions (
            user_id,
            video_id,
            program_week,
            workout_date,
            completed_at,
            source
          )
          SELECT user_id, video_id, $3, CURRENT_DATE, NOW(), 'player'
          FROM eligible_workout
          ON CONFLICT (user_id, video_id, program_week) DO NOTHING
          RETURNING id
        )
        SELECT
          EXISTS(SELECT 1 FROM eligible_workout) AS eligible,
          EXISTS(SELECT 1 FROM inserted) AS inserted
      `,
      [userId, videoId, programWeek],
    );
    const row = result.rows[0];

    if (row === undefined || !row.eligible) {
      return { kind: 'workout_not_found' };
    }

    return { kind: 'completed', inserted: row.inserted };
  }
}
