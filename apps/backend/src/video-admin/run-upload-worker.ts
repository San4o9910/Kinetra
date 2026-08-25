import { SystemClock } from '../auth/service.js';
import { closeDatabasePool } from '../db/pool.js';
import { createProductionVideoAdminRuntime } from './runtime.js';
import { VideoUploadWorkerService } from './worker-service.js';

const runtime = createProductionVideoAdminRuntime();
void new VideoUploadWorkerService(
  runtime.repository,
  runtime.storage,
  (await import('../config/env.js')).env.videoUploads,
  new SystemClock(),
)
  .runOnce()
  .then((summary) => console.log('Kinetra video verification worker completed.', summary))
  .catch(() => {
    console.error('Kinetra video verification worker failed.');
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
