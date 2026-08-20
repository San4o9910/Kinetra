import type { ProgramDirection } from '@kinetra/shared';

export const PROGRAM_WEEK_COUNT = 12;
export const PROGRAM_DAYS_PER_WEEK = 7;

export interface ProgramProgressSnapshot {
  readonly currentWeekNumber: number;
  readonly totalWeeks: number;
  readonly weeksCompleted: number;
  readonly totalWorkoutsDone: number;
}

export interface ProgramDaySnapshot {
  readonly id: string;
  readonly dayOfWeek: number;
  readonly direction: ProgramDirection;
  readonly title: string;
  readonly description: string | null;
  readonly durationMinutes: number;
  readonly icon: string;
  readonly videoId: string;
  readonly storageKey: string | null;
  readonly posterKey: string | null;
  readonly mediaAvailable: boolean;
  readonly completedAt: Date | null;
}

export interface ProgramWeekSnapshot {
  readonly id: string;
  readonly weekNumber: number;
  readonly title: string;
  readonly days: readonly ProgramDaySnapshot[];
}

export type CompleteWorkoutResult =
  | { readonly kind: 'completed'; readonly inserted: boolean }
  | { readonly kind: 'workout_not_found' };

export interface ProgramRepository {
  getProgress(userId: string): Promise<ProgramProgressSnapshot>;
  getWeek(userId: string, weekNumber: number): Promise<ProgramWeekSnapshot | null>;
  completeWorkout(
    userId: string,
    videoId: string,
    programWeek: number,
  ): Promise<CompleteWorkoutResult>;
}
