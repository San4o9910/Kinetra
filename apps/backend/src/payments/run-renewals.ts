import type pg from 'pg';
import { SystemClock } from '../auth/service.js';
import { parseRenewalJobEnvironment } from '../config/job-env.js';
import { createJobDatabasePool } from '../db/job-pool.js';
import { PostgresPaymentsRepository } from './postgres-payments.repository.js';
import { ConsoleRenewalFailureNotifier, RenewalService } from './renewal-service.js';
import { HttpYooKassaClient } from './yookassa-client.js';

let exitCode = 0;
let databasePool: pg.Pool | null = null;
try {
  const config = parseRenewalJobEnvironment();
  databasePool = createJobDatabasePool('kinetra-renewals', config.databaseUrl);
  const summary = await new RenewalService(
    new PostgresPaymentsRepository(databasePool),
    new HttpYooKassaClient(config.yookassa),
    new SystemClock(),
    new ConsoleRenewalFailureNotifier(),
  ).run();
  console.log('Kinetra renewal run completed.', summary);
  if (summary.failed > 0) exitCode = 1;
} catch {
  exitCode = 1;
  console.error('Kinetra renewal run failed.');
} finally {
  try {
    await databasePool?.end();
  } catch {
    exitCode = 1;
    console.error('Kinetra renewal database cleanup failed.');
  }
}
process.exitCode = exitCode;
