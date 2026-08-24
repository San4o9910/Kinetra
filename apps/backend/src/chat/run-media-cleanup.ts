import { createProductionChatRuntime } from './runtime.js';
import { closeDatabasePool } from '../db/pool.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const run = async (): Promise<void> => {
  const runtime = createProductionChatRuntime();
  const summary = await runtime.cleanupService.runOnce();
  console.log('Kinetra chat media cleanup completed.', {
    stalePhotosRemoved: summary.stalePhotosRemoved,
    deletionsCompleted: summary.deletionsCompleted,
    deletionsFailed: summary.deletionsFailed,
    pendingDeletionJobs: summary.pendingDeletionJobs,
    dueDeletionJobs: summary.dueDeletionJobs,
    oldestDeletionRequestedAt: summary.oldestDeletionRequestedAt,
    oldestDeletionAgeMs: summary.oldestDeletionAgeMs,
  });

  if ((summary.oldestDeletionAgeMs ?? 0) > DAY_MS) {
    console.error('Kinetra chat media cleanup alert: durable deletion backlog exceeds 24 hours.', {
      pendingDeletionJobs: summary.pendingDeletionJobs,
      dueDeletionJobs: summary.dueDeletionJobs,
      oldestDeletionRequestedAt: summary.oldestDeletionRequestedAt,
      oldestDeletionAgeMs: summary.oldestDeletionAgeMs,
    });
  }

  if (summary.deletionsFailed > 0 || (summary.oldestDeletionAgeMs ?? 0) > DAY_MS) {
    process.exitCode = 1;
  }
};

void run()
  .catch(() => {
    console.error('Kinetra chat media cleanup failed.');
    process.exitCode = 1;
  })
  .finally(async () => closeDatabasePool());
