import type { OnboardingStatus } from '@kinetra/shared';

export interface BaseLessonSnapshot {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly durationSeconds: number;
  readonly orderIndex: number;
  readonly storageKey: string | null;
  readonly posterKey: string | null;
  readonly completionPercent: number;
}

export interface LessonProgressInput {
  readonly positionSeconds: number;
  readonly completionPercent: number;
}

export interface LessonProgressSnapshot extends LessonProgressInput {
  readonly completedAt: Date | null;
}

export type CompleteBaseProgramResult =
  | { readonly kind: 'activated' }
  | { readonly kind: 'already_active' }
  | { readonly kind: 'insufficient_lessons'; readonly totalCompleted: number }
  | { readonly kind: 'invalid_onboarding_state'; readonly status: OnboardingStatus }
  | { readonly kind: 'user_not_found' };

export interface BaseLessonsRepository {
  listForUser(userId: string): Promise<readonly BaseLessonSnapshot[]>;
  saveProgress(
    userId: string,
    lessonId: string,
    input: LessonProgressInput,
  ): Promise<LessonProgressSnapshot | null>;
  completeProgram(userId: string, threshold: number): Promise<CompleteBaseProgramResult>;
}
