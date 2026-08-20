import type { OnboardingStatus } from '@kinetra/shared';

import type {
  BaseLessonSnapshot,
  BaseLessonsRepository,
  CompleteBaseProgramResult,
  LessonProgressInput,
  LessonProgressSnapshot,
} from '../../src/base-lessons/repository.js';

const lessonTitles = [
  'Как понять правильно ли я дышу?',
  'Как правильно отжиматься?',
  'Как научиться подтягиваться?',
  'Как приседать?',
  'Как и зачем делать становую тягу?',
  'Я не хочу заниматься каждый день!',
  'Что я ем?',
] as const;

const lessonIds = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007',
] as const;

export interface InMemoryBaseLessonsRepositoryOptions {
  readonly onboardingStatus?: OnboardingStatus;
  readonly firstLessonStorageKey?: string | null;
  readonly firstLessonPosterKey?: string | null;
}

export class InMemoryBaseLessonsRepository implements BaseLessonsRepository {
  private readonly lessons: BaseLessonSnapshot[];
  private readonly progress = new Map<string, LessonProgressSnapshot>();
  private onboardingStatus: OnboardingStatus;

  public constructor(
    private readonly userId: string,
    options: InMemoryBaseLessonsRepositoryOptions = {},
  ) {
    this.onboardingStatus = options.onboardingStatus ?? 'base_lessons';
    this.lessons = lessonTitles.map((title, index) => ({
      id: lessonIds[index] as string,
      slug: `base-lesson-${String(index + 1).padStart(2, '0')}`,
      title,
      description: `Описание урока ${index + 1}`,
      durationSeconds: 600,
      orderIndex: index + 1,
      storageKey: index === 0 ? (options.firstLessonStorageKey ?? null) : null,
      posterKey: index === 0 ? (options.firstLessonPosterKey ?? null) : null,
      completionPercent: 0,
    }));
  }

  public async listForUser(userId: string): Promise<readonly BaseLessonSnapshot[]> {
    return this.lessons.map((lesson) => ({
      ...lesson,
      completionPercent:
        userId === this.userId ? (this.progress.get(lesson.id)?.completionPercent ?? 0) : 0,
    }));
  }

  public async saveProgress(
    userId: string,
    lessonId: string,
    input: LessonProgressInput,
  ): Promise<LessonProgressSnapshot | null> {
    if (userId !== this.userId || !this.lessons.some((lesson) => lesson.id === lessonId)) {
      return null;
    }

    const existing = this.progress.get(lessonId);
    const completionPercent = Math.max(existing?.completionPercent ?? 0, input.completionPercent);
    const completedAt =
      completionPercent >= 90
        ? (existing?.completedAt ?? new Date('2026-08-20T12:00:00.000Z'))
        : null;
    const snapshot: LessonProgressSnapshot = {
      positionSeconds: input.positionSeconds,
      completionPercent,
      completedAt,
    };
    this.progress.set(lessonId, snapshot);
    return { ...snapshot };
  }

  public async completeProgram(
    userId: string,
    threshold: number,
  ): Promise<CompleteBaseProgramResult> {
    if (userId !== this.userId) {
      return { kind: 'user_not_found' };
    }

    if (this.onboardingStatus === 'active') {
      return { kind: 'already_active' };
    }

    if (this.onboardingStatus !== 'base_lessons') {
      return {
        kind: 'invalid_onboarding_state',
        status: this.onboardingStatus,
      };
    }

    const totalCompleted = [...this.progress.values()].filter(
      (item) => item.completionPercent >= 90,
    ).length;

    if (totalCompleted < threshold) {
      return { kind: 'insufficient_lessons', totalCompleted };
    }

    this.onboardingStatus = 'active';
    return { kind: 'activated' };
  }

  public get lessonIds(): readonly string[] {
    return lessonIds;
  }

  public get status(): OnboardingStatus {
    return this.onboardingStatus;
  }
}
