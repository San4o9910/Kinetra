import type {
  BaseLessonProgress,
  BaseLessonsResponse,
  LessonProgressResponse,
  UpdateLessonProgressRequest,
} from '@kinetra/shared';

export const PROGRESS_SYNC_INTERVAL_MS = 10_000;

export type BaseLessonCompletionState = 'completed' | 'in_progress' | 'not_started';

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const clampCompletionPercent = (value: number): number =>
  Number.isFinite(value) ? clamp(value, 0, 100) : 0;

export const formatLessonDuration = (durationSeconds: number): string => {
  const safeDuration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  return `${Math.max(1, Math.ceil(safeDuration / 60))} мин`;
};

export const completionStateForProgress = (
  progress: BaseLessonProgress,
): BaseLessonCompletionState => {
  const completionPercent = clampCompletionPercent(progress.completion_percent);

  if (progress.completed || completionPercent >= 90) {
    return 'completed';
  }

  return completionPercent > 0 ? 'in_progress' : 'not_started';
};

export const remainingLessonCount = (totalCompleted: number, unlockThreshold: number): number =>
  Math.max(0, unlockThreshold - totalCompleted);

export const baseProgramActionLabel = (totalCompleted: number, unlockThreshold: number): string => {
  const remaining = remainingLessonCount(totalCompleted, unlockThreshold);
  return remaining === 0 ? 'Перейти к программе' : `Пройдите ещё ${remaining} уроков`;
};

export const overallProgressPercent = (totalCompleted: number, lessonCount: number): number =>
  lessonCount <= 0 ? 0 : clampCompletionPercent((totalCompleted / lessonCount) * 100);

export const mergeSavedLessonProgress = (
  response: BaseLessonsResponse,
  lessonId: string,
  savedProgress: LessonProgressResponse | null,
): BaseLessonsResponse => {
  if (savedProgress === null || !response.lessons.some(({ id }) => id === lessonId)) {
    return response;
  }

  const lessons = response.lessons.map((lesson) =>
    lesson.id === lessonId
      ? {
          ...lesson,
          progress: {
            completion_percent: savedProgress.completion_percent,
            completed: savedProgress.completed,
          },
        }
      : lesson,
  );
  const totalCompleted = lessons.filter(({ progress }) => progress.completed).length;

  return {
    ...response,
    lessons,
    total_completed: totalCompleted,
    program_unlocked: totalCompleted >= response.unlock_threshold,
  };
};

export class LatestRequestGuard {
  private latestRequest = 0;

  public begin(): number {
    this.latestRequest += 1;
    return this.latestRequest;
  }

  public isLatest(request: number): boolean {
    return request === this.latestRequest;
  }
}

export const createProgressSnapshot = (
  positionSeconds: number,
  durationSeconds: number,
  previousHighWater: number,
  forceComplete = false,
): UpdateLessonProgressRequest => {
  const safeDuration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const safePosition = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;
  const boundedPosition = safeDuration > 0 ? Math.min(safePosition, safeDuration) : safePosition;
  const watchedPercent =
    forceComplete || (safeDuration > 0 && boundedPosition >= safeDuration)
      ? 100
      : safeDuration > 0
        ? (boundedPosition / safeDuration) * 100
        : 0;

  return {
    position_seconds: Math.floor(boundedPosition),
    completion_percent: Number(
      Math.max(clampCompletionPercent(previousHighWater), watchedPercent).toFixed(2),
    ),
  };
};

type ProgressSender = (progress: UpdateLessonProgressRequest) => Promise<LessonProgressResponse>;

interface ProgressWaiter {
  readonly resolve: (progress: LessonProgressResponse) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingProgressBatch {
  progress: UpdateLessonProgressRequest;
  readonly waiters: ProgressWaiter[];
}

const mergeProgress = (
  current: UpdateLessonProgressRequest,
  next: UpdateLessonProgressRequest,
): UpdateLessonProgressRequest => ({
  position_seconds: next.position_seconds,
  completion_percent: Math.max(current.completion_percent, next.completion_percent),
});

export class LessonProgressReporter {
  private highWaterCompletion: number;
  private pending: PendingProgressBatch | null = null;
  private drainInFlight: Promise<void> | null = null;

  public constructor(
    initialCompletionPercent: number,
    private readonly send: ProgressSender,
  ) {
    this.highWaterCompletion = clampCompletionPercent(initialCompletionPercent);
  }

  public snapshot(
    positionSeconds: number,
    durationSeconds: number,
    forceComplete = false,
  ): UpdateLessonProgressRequest {
    const progress = createProgressSnapshot(
      positionSeconds,
      durationSeconds,
      this.highWaterCompletion,
      forceComplete,
    );
    this.highWaterCompletion = progress.completion_percent;
    return progress;
  }

  public enqueue(progress: UpdateLessonProgressRequest): Promise<LessonProgressResponse> {
    this.highWaterCompletion = Math.max(
      this.highWaterCompletion,
      clampCompletionPercent(progress.completion_percent),
    );

    const queued = new Promise<LessonProgressResponse>((resolve, reject) => {
      const waiter = { resolve, reject };

      if (this.pending === null) {
        this.pending = { progress, waiters: [waiter] };
      } else {
        this.pending.progress = mergeProgress(this.pending.progress, progress);
        this.pending.waiters.push(waiter);
      }
    });

    this.startDrain();
    return queued;
  }

  public async flush(progress: UpdateLessonProgressRequest): Promise<LessonProgressResponse> {
    const response = await this.enqueue(progress);
    await this.waitUntilIdle();
    return response;
  }

  private async waitUntilIdle(): Promise<void> {
    while (this.drainInFlight !== null) {
      await this.drainInFlight;
    }
  }

  private startDrain(): void {
    if (this.drainInFlight !== null) {
      return;
    }

    const drain = async (): Promise<void> => {
      while (this.pending !== null) {
        const batch = this.pending;
        this.pending = null;

        try {
          const updated = await this.send(batch.progress);
          this.highWaterCompletion = Math.max(
            this.highWaterCompletion,
            clampCompletionPercent(updated.completion_percent),
          );
          batch.waiters.forEach(({ resolve }) => resolve(updated));
        } catch (error) {
          batch.waiters.forEach(({ reject }) => reject(error));
        }
      }
    };

    this.drainInFlight = drain().finally(() => {
      this.drainInFlight = null;

      if (this.pending !== null) {
        this.startDrain();
      }
    });
  }
}
