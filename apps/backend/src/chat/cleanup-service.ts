import type { Clock } from '../auth/service.js';
import type { ChatMediaStore } from './media.js';
import type { ChatRepository } from './repository.js';

export interface ChatMediaCleanupSummary {
  readonly stalePhotosRemoved: number;
  readonly deletionsCompleted: number;
  readonly deletionsFailed: number;
  readonly pendingDeletionJobs: number;
  readonly dueDeletionJobs: number;
  readonly oldestDeletionRequestedAt: string | null;
  readonly oldestDeletionAgeMs: number | null;
}

const retryDelayMs = (attemptCount: number): number =>
  Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.min(attemptCount - 1, 10));

export class ChatMediaCleanupService {
  public constructor(
    private readonly repository: ChatRepository,
    private readonly mediaStore: ChatMediaStore,
    private readonly clock: Clock,
  ) {}

  public async runOnce(batchSize = 100): Promise<ChatMediaCleanupSummary> {
    const now = this.clock.now();
    const stalePhotosRemoved = await this.repository.expireStalePhotos(now, batchSize);
    const jobs = await this.repository.claimMediaDeletionJobs(now, batchSize);
    let deletionsCompleted = 0;
    let deletionsFailed = 0;

    for (const job of jobs) {
      try {
        await this.repository.withMediaObjectLock(job.objectKey, async (lease) => {
          if (!this.mediaStore.available) {
            throw new Error('Media store unavailable.');
          }

          await this.mediaStore.deleteObject(job.objectKey);
          await lease.completeMediaDeletion(job.objectKey, this.clock.now());
        });
        deletionsCompleted += 1;
      } catch {
        const nextAttemptAt = new Date(this.clock.now().getTime() + retryDelayMs(job.attemptCount));
        await this.repository.retryMediaDeletion(
          job.objectKey,
          'object_delete_failed',
          nextAttemptAt,
        );
        deletionsFailed += 1;
      }
    }

    const observedAt = this.clock.now();
    const backlog = await this.repository.getMediaDeletionBacklog(observedAt);
    return {
      stalePhotosRemoved,
      deletionsCompleted,
      deletionsFailed,
      pendingDeletionJobs: backlog.pendingCount,
      dueDeletionJobs: backlog.dueCount,
      oldestDeletionRequestedAt: backlog.oldestRequestedAt?.toISOString() ?? null,
      oldestDeletionAgeMs:
        backlog.oldestRequestedAt === null
          ? null
          : Math.max(0, observedAt.getTime() - backlog.oldestRequestedAt.getTime()),
    };
  }
}
