import type {
  ProgramDay,
  ProgramDayLabel,
  ProgramDirection,
  ProgramScheduleDay,
  ProgramScheduleWeek,
  ProgramWeekStatus,
  ScheduleResponse,
  WeekResponse,
} from '@kinetra/shared';

import { HttpError } from '../auth/errors.js';
import type { ObjectUrlSigner } from '../base-lessons/storage.js';
import {
  PROGRAM_DAYS_PER_WEEK,
  PROGRAM_WEEK_COUNT,
  type ProgramDaySnapshot,
  type ProgramProgressSnapshot,
  type ProgramRepository,
  type ProgramWeekSnapshot,
} from './repository.js';
import { programWeekNumberSchema, workoutCompletionSchema } from './schema.js';

const programIconByDirection = Object.freeze({
  breathing: '🧘',
  strength: '💪',
  body_therapy: '🌿',
  functional: '⚡',
  stretching: '🧘‍♂️',
  neuro: '🧠',
  recovery: '🍲',
} satisfies Readonly<Record<ProgramDirection, string>>);

const programDayLabelByNumber: Readonly<Partial<Record<number, ProgramDayLabel>>> = Object.freeze({
  1: 'Понедельник',
  2: 'Вторник',
  3: 'Среда',
  4: 'Четверг',
  5: 'Пятница',
  6: 'Суббота',
  7: 'Воскресенье',
});

const validationError = (code: string, fallbackMessage: string, issues: readonly unknown[]) => {
  const firstIssue = issues[0];
  const message =
    typeof firstIssue === 'object' &&
    firstIssue !== null &&
    'message' in firstIssue &&
    typeof firstIssue.message === 'string'
      ? firstIssue.message
      : fallbackMessage;

  return new HttpError(400, code, message);
};

export class ProgramService {
  public constructor(
    private readonly repository: ProgramRepository,
    private readonly objectUrlSigner: ObjectUrlSigner,
  ) {}

  public async getCurrentWeek(userId: string): Promise<WeekResponse> {
    const progress = await this.repository.getProgress(userId);
    return this.getWeekResponse(userId, progress.currentWeekNumber, progress);
  }

  public async getSchedule(userId: string): Promise<ScheduleResponse> {
    const progress = await this.repository.getProgress(userId);
    const nextWeekNumber =
      progress.currentWeekNumber < PROGRAM_WEEK_COUNT ? progress.currentWeekNumber + 1 : null;
    const [currentWeek, nextWeek] = await Promise.all([
      this.getRequiredWeekSnapshot(userId, progress.currentWeekNumber),
      nextWeekNumber === null
        ? Promise.resolve(null)
        : this.getRequiredWeekSnapshot(userId, nextWeekNumber),
    ]);

    return {
      current_week: this.scheduleWeekResponse(currentWeek),
      next_week: nextWeek === null ? null : this.scheduleWeekResponse(nextWeek),
    };
  }

  public async getWeek(userId: string, rawWeekNumber: unknown): Promise<WeekResponse> {
    const parsedWeekNumber = programWeekNumberSchema.safeParse(rawWeekNumber);

    if (!parsedWeekNumber.success) {
      throw validationError(
        'INVALID_WEEK_NUMBER',
        'The program week number is invalid.',
        parsedWeekNumber.error.issues,
      );
    }

    const progress = await this.repository.getProgress(userId);

    if (parsedWeekNumber.data > progress.currentWeekNumber + 1) {
      throw new HttpError(403, 'PROGRAM_WEEK_LOCKED', 'This program week is not available yet.');
    }

    return this.getWeekResponse(userId, parsedWeekNumber.data, progress);
  }

  public async completeWorkout(userId: string, body: unknown): Promise<WeekResponse> {
    const parsedBody = workoutCompletionSchema.safeParse(body);

    if (!parsedBody.success) {
      throw validationError(
        'INVALID_WORKOUT_COMPLETION',
        'Workout completion data is invalid.',
        parsedBody.error.issues,
      );
    }

    const progress = await this.repository.getProgress(userId);

    if (parsedBody.data.program_week !== progress.currentWeekNumber) {
      if (parsedBody.data.program_week < progress.currentWeekNumber) {
        const previousWeek = await this.repository.getWeek(userId, parsedBody.data.program_week);
        const existingCompletion = previousWeek?.days.find(
          (day) => day.videoId === parsedBody.data.video_id,
        );

        if (existingCompletion !== undefined && existingCompletion.completedAt !== null) {
          return this.getWeekResponse(userId, progress.currentWeekNumber, progress);
        }
      }

      throw new HttpError(
        403,
        'PROGRAM_WEEK_LOCKED',
        'Only workouts from the current program week can be completed.',
      );
    }

    const completion = await this.repository.completeWorkout(
      userId,
      parsedBody.data.video_id,
      parsedBody.data.program_week,
    );

    if (completion.kind === 'workout_not_found') {
      throw new HttpError(
        404,
        'WORKOUT_NOT_FOUND',
        'The workout was not found in the requested program week.',
      );
    }

    return this.getCurrentWeek(userId);
  }

  private async getWeekResponse(
    userId: string,
    weekNumber: number,
    progress: ProgramProgressSnapshot,
  ): Promise<WeekResponse> {
    const snapshot = await this.getRequiredWeekSnapshot(userId, weekNumber);

    const status = this.statusFor(snapshot, progress.currentWeekNumber);
    const days = await Promise.all(
      snapshot.days.map((day) => this.dayResponse(day, status !== 'locked' && day.mediaAvailable)),
    );

    return {
      week: {
        id: snapshot.id,
        week_number: snapshot.weekNumber,
        title: snapshot.title,
        status,
        days,
        days_completed: days.filter((day) => day.completed).length,
        total_days: PROGRAM_DAYS_PER_WEEK,
      },
      total_weeks: progress.totalWeeks,
      overall_progress: {
        weeks_completed: progress.weeksCompleted,
        total_workouts_done: progress.totalWorkoutsDone,
      },
    };
  }

  private async getRequiredWeekSnapshot(
    userId: string,
    weekNumber: number,
  ): Promise<ProgramWeekSnapshot> {
    const snapshot = await this.repository.getWeek(userId, weekNumber);

    if (snapshot === null) {
      throw new HttpError(404, 'PROGRAM_WEEK_NOT_FOUND', 'The program week was not found.');
    }

    if (snapshot.days.length !== PROGRAM_DAYS_PER_WEEK) {
      throw new Error(
        `Program week ${weekNumber} has ${snapshot.days.length} days instead of ${PROGRAM_DAYS_PER_WEEK}.`,
      );
    }

    return snapshot;
  }

  private scheduleWeekResponse(snapshot: ProgramWeekSnapshot): ProgramScheduleWeek {
    const days = snapshot.days.map((day) => this.scheduleDayResponse(day));

    return {
      week_number: snapshot.weekNumber,
      title: snapshot.title,
      days,
      days_completed: days.filter((day) => day.completed).length,
      total_days: PROGRAM_DAYS_PER_WEEK,
    };
  }

  private scheduleDayResponse(day: ProgramDaySnapshot): ProgramScheduleDay {
    const dayLabel = programDayLabelByNumber[day.dayOfWeek];
    const description = day.description?.trim();

    if (dayLabel === undefined) {
      throw new Error(`Program day ${day.dayOfWeek} does not have a supported weekday label.`);
    }

    if (description === undefined || description.length === 0) {
      throw new Error(`Program day ${day.dayOfWeek} does not have a schedule description.`);
    }

    return {
      day_of_week: day.dayOfWeek,
      day_label: dayLabel,
      direction: day.direction,
      icon: programIconByDirection[day.direction],
      title: day.title,
      description,
      duration_minutes: day.durationMinutes,
      completed: day.completedAt !== null,
    };
  }

  private statusFor(snapshot: ProgramWeekSnapshot, currentWeekNumber: number): ProgramWeekStatus {
    if (snapshot.weekNumber > currentWeekNumber) {
      return 'locked';
    }

    if (
      snapshot.weekNumber < currentWeekNumber ||
      snapshot.days.every((day) => day.completedAt !== null)
    ) {
      return 'completed';
    }

    return 'active';
  }

  private async dayResponse(
    day: ProgramDaySnapshot,
    includeObjectUrls: boolean,
  ): Promise<ProgramDay> {
    const [videoUrl, posterUrl] = includeObjectUrls
      ? await Promise.all([this.objectUrlFor(day.storageKey), this.objectUrlFor(day.posterKey)])
      : [null, null];

    return {
      id: day.id,
      day_of_week: day.dayOfWeek,
      direction: day.direction,
      title: day.title,
      description: day.description,
      duration_minutes: day.durationMinutes,
      icon: programIconByDirection[day.direction],
      video: {
        id: day.videoId,
        video_url: videoUrl,
        poster_url: posterUrl,
      },
      completed: day.completedAt !== null,
      completed_at: day.completedAt?.toISOString() ?? null,
    };
  }

  private async objectUrlFor(key: string | null): Promise<string | null> {
    return key === null || key.trim().length === 0 ? null : this.objectUrlSigner.getObjectUrl(key);
  }
}
