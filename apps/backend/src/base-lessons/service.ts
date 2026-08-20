import type {
  BaseLesson,
  BaseLessonsResponse,
  LessonProgressResponse,
  MeResponse,
} from '@kinetra/shared';

import { HttpError } from '../auth/errors.js';
import type { BaseLessonsRepository, BaseLessonSnapshot } from './repository.js';
import { lessonIdSchema, lessonProgressSchema } from './schema.js';
import type { ObjectUrlSigner } from './storage.js';

export const BASE_LESSON_UNLOCK_THRESHOLD = 4;

export interface ProfileReader {
  getProfile(userId: string): Promise<MeResponse>;
}

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

export class BaseLessonsService {
  public constructor(
    private readonly repository: BaseLessonsRepository,
    private readonly objectUrlSigner: ObjectUrlSigner,
    private readonly profileReader: ProfileReader,
  ) {}

  public async getLessons(userId: string): Promise<BaseLessonsResponse> {
    const snapshots = await this.repository.listForUser(userId);
    const lessons = await Promise.all(snapshots.map((lesson) => this.toResponse(lesson)));
    const totalCompleted = lessons.filter((lesson) => lesson.progress.completed).length;

    return {
      lessons,
      total_completed: totalCompleted,
      unlock_threshold: BASE_LESSON_UNLOCK_THRESHOLD,
      program_unlocked: totalCompleted >= BASE_LESSON_UNLOCK_THRESHOLD,
    };
  }

  public async updateProgress(
    userId: string,
    rawLessonId: unknown,
    body: unknown,
  ): Promise<LessonProgressResponse> {
    const parsedLessonId = lessonIdSchema.safeParse(rawLessonId);

    if (!parsedLessonId.success) {
      throw validationError(
        'INVALID_LESSON_ID',
        'The lesson identifier is invalid.',
        parsedLessonId.error.issues,
      );
    }

    const parsedBody = lessonProgressSchema.safeParse(body);

    if (!parsedBody.success) {
      throw validationError(
        'INVALID_LESSON_PROGRESS',
        'Lesson progress is invalid.',
        parsedBody.error.issues,
      );
    }

    const progress = await this.repository.saveProgress(userId, parsedLessonId.data, {
      positionSeconds: parsedBody.data.position_seconds,
      completionPercent: parsedBody.data.completion_percent,
    });

    if (progress === null) {
      throw new HttpError(404, 'BASE_LESSON_NOT_FOUND', 'The base lesson was not found.');
    }

    return {
      position_seconds: progress.positionSeconds,
      completion_percent: progress.completionPercent,
      completed: progress.completionPercent >= 90,
      completed_at: progress.completedAt?.toISOString() ?? null,
    };
  }

  public async completeProgram(userId: string): Promise<MeResponse> {
    const result = await this.repository.completeProgram(userId, BASE_LESSON_UNLOCK_THRESHOLD);

    if (result.kind === 'user_not_found') {
      throw new HttpError(
        404,
        'PROFILE_NOT_FOUND',
        'The authenticated user profile was not found.',
      );
    }

    if (result.kind === 'invalid_onboarding_state') {
      throw new HttpError(
        409,
        'INVALID_ONBOARDING_STATE',
        `Cannot activate the program while onboarding status is ${result.status}.`,
      );
    }

    if (result.kind === 'insufficient_lessons') {
      throw new HttpError(
        400,
        'INSUFFICIENT_LESSONS',
        `Complete at least ${BASE_LESSON_UNLOCK_THRESHOLD} base lessons before opening the program.`,
      );
    }

    return this.profileReader.getProfile(userId);
  }

  private async toResponse(lesson: BaseLessonSnapshot): Promise<BaseLesson> {
    const [posterUrl, videoUrl] = await Promise.all([
      this.objectUrlFor(lesson.posterKey),
      this.objectUrlFor(lesson.storageKey),
    ]);

    return {
      id: lesson.id,
      slug: lesson.slug,
      title: lesson.title,
      description: lesson.description,
      duration_seconds: lesson.durationSeconds,
      order_index: lesson.orderIndex,
      poster_url: posterUrl,
      video_url: videoUrl,
      progress: {
        completion_percent: lesson.completionPercent,
        completed: lesson.completionPercent >= 90,
      },
    };
  }

  private async objectUrlFor(key: string | null): Promise<string | null> {
    return key === null || key.trim().length === 0 ? null : this.objectUrlSigner.getObjectUrl(key);
  }
}
