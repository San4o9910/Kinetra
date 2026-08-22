import { closeDatabasePool } from '../db/pool.js';
import { createProductionPaymentsRuntime } from './runtime.js';

let exitCode = 0;

try {
  const summary = await createProductionPaymentsRuntime().renewalService.run();
  console.log('Kinetra renewal run completed.', summary);
} catch (error) {
  exitCode = 1;
  console.error('Kinetra renewal run failed.', error);
} finally {
  await closeDatabasePool();
}

process.exitCode = exitCode;
