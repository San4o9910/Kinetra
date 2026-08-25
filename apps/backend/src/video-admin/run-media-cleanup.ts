import { SystemClock } from '../auth/service.js';
import { closeDatabasePool } from '../db/pool.js';
import { createProductionVideoCleanupRuntime } from './runtime.js';
import { VideoMediaCleanupService } from './worker-service.js';

const runtime = createProductionVideoCleanupRuntime();
void new VideoMediaCleanupService(runtime.repository, runtime.storage, new SystemClock())
  .runOnce()
  .then((summary) => console.log('Kinetra video cleanup worker completed.', summary))
  .catch(() => {
    console.error('Kinetra video cleanup worker failed.');
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
