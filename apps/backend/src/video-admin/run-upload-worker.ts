import type pg from 'pg';
import { SystemClock } from '../auth/service.js';
import { parseVideoVerificationJobEnvironment } from '../config/job-env.js';
import { createJobDatabasePool } from '../db/job-pool.js';
import { PostgresVideoAdminRepository } from './postgres-video.repository.js';
import { S3VideoStorage } from './storage.js';
import { assertVideoVerifierAvailable } from './verifier.js';
import { VideoUploadWorkerService } from './worker-service.js';

let exitCode = 0;
let databasePool: pg.Pool | null = null;
try {
  const config = parseVideoVerificationJobEnvironment();
  assertVideoVerifierAvailable(config.videoUploads.ffprobePath);
  databasePool = createJobDatabasePool('kinetra-video-verifier', config.databaseUrl);
  const summary = await new VideoUploadWorkerService(
    new PostgresVideoAdminRepository(databasePool),
    new S3VideoStorage(config.s3, config.videoUploads),
    config.videoUploads,
    new SystemClock(),
  ).runOnce();
  console.log('Kinetra video verification worker completed.', summary);
} catch {
  exitCode = 1;
  console.error('Kinetra video verification worker failed.');
} finally {
  try {
    await databasePool?.end();
  } catch {
    exitCode = 1;
    console.error('Kinetra verification database cleanup failed.');
  }
}
process.exitCode = exitCode;
