import type pg from 'pg';
import { SystemClock } from '../auth/service.js';
import { parseMediaCleanupJobEnvironment } from '../config/job-env.js';
import { createJobDatabasePool } from '../db/job-pool.js';
import { PostgresVideoAdminRepository } from './postgres-video.repository.js';
import { S3VideoStorage } from './storage.js';
import { VideoMediaCleanupService } from './worker-service.js';

let exitCode = 0;
let databasePool: pg.Pool | null = null;
try {
  const config = parseMediaCleanupJobEnvironment();
  databasePool = createJobDatabasePool('kinetra-video-cleanup', config.databaseUrl);
  const summary = await new VideoMediaCleanupService(
    new PostgresVideoAdminRepository(databasePool),
    new S3VideoStorage(config.s3),
    new SystemClock(),
  ).runOnce();
  console.log('Kinetra video cleanup worker completed.', summary);
} catch {
  exitCode = 1;
  console.error('Kinetra video cleanup worker failed.');
} finally {
  try {
    await databasePool?.end();
  } catch {
    exitCode = 1;
    console.error('Kinetra video cleanup database cleanup failed.');
  }
}
process.exitCode = exitCode;
