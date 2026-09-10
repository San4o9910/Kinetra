import type pg from 'pg';
import { SystemClock } from '../auth/service.js';
import { parseNotificationJobEnvironment } from '../config/job-env.js';
import { createJobDatabasePool } from '../db/job-pool.js';
import { PostgresSubscriptionAccessChecker } from '../payments/subscription-access.js';
import { PostgresProgramRepository } from '../program/postgres-program.repository.js';
import { PostgresProgressRepository } from '../progress/postgres-progress.repository.js';
import { PostgresPushRepository } from './postgres-push.repository.js';
import { NotificationSchedulerService } from './scheduler-service.js';
import { WebPushSender } from './webpush-sender.js';

let exitCode = 0;
let databasePool: pg.Pool | null = null;
try {
  const config = parseNotificationJobEnvironment();
  databasePool = createJobDatabasePool('kinetra-notifications', config.databaseUrl);
  const summary = await new NotificationSchedulerService(
    new PostgresPushRepository(databasePool),
    new PostgresProgramRepository(databasePool),
    new PostgresProgressRepository(databasePool),
    new PostgresSubscriptionAccessChecker(databasePool),
    new WebPushSender(config.vapid),
    new SystemClock(),
  ).run();
  console.log('Kinetra notification run completed.', summary);
  if (summary.failed > 0) exitCode = 1;
} catch {
  exitCode = 1;
  console.error('Kinetra notification run failed.');
} finally {
  try {
    await databasePool?.end();
  } catch {
    exitCode = 1;
    console.error('Kinetra notification database cleanup failed.');
  }
}
process.exitCode = exitCode;
