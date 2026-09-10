import type pg from 'pg';
import { SystemClock } from '../auth/service.js';
import { parseMediaCleanupJobEnvironment } from '../config/job-env.js';
import { createJobDatabasePool } from '../db/job-pool.js';
import { ChatMediaCleanupService } from './cleanup-service.js';
import { PostgresChatRepository } from './postgres-chat.repository.js';
import { S3ChatMediaStore } from './s3-chat-media.store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
let exitCode = 0;
let databasePool: pg.Pool | null = null;
try {
  const config = parseMediaCleanupJobEnvironment();
  databasePool = createJobDatabasePool('kinetra-chat-cleanup', config.databaseUrl);
  const summary = await new ChatMediaCleanupService(
    new PostgresChatRepository(databasePool),
    new S3ChatMediaStore(config.s3),
    new SystemClock(),
  ).runOnce();
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
  if (summary.deletionsFailed > 0 || (summary.oldestDeletionAgeMs ?? 0) > DAY_MS) exitCode = 1;
} catch {
  exitCode = 1;
  console.error('Kinetra chat media cleanup failed.');
} finally {
  try {
    await databasePool?.end();
  } catch {
    exitCode = 1;
    console.error('Kinetra chat cleanup database cleanup failed.');
  }
}
process.exitCode = exitCode;
