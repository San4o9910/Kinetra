import { closeDatabasePool } from '../db/pool.js';
import { createProductionPushRuntime } from './runtime.js';

let exitCode = 0;

try {
  const runtime = createProductionPushRuntime();

  if (!runtime.configured) {
    throw new Error('Web Push is not configured.');
  }

  const summary = await runtime.schedulerService.run();
  console.log('Kinetra notification run completed.', summary);
} catch (error) {
  exitCode = 1;
  console.error('Kinetra notification run failed.', error);
} finally {
  await closeDatabasePool();
}

process.exitCode = exitCode;
