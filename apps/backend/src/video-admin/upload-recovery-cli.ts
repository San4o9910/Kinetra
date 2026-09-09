import { z } from 'zod';

import { PostgresVideoAdminRepository } from './postgres-video.repository.js';

let closeDatabasePool: (() => Promise<void>) | undefined;

const help = 'Usage: retry --upload-id <UUID>';

const uploadIdFrom = (arguments_: readonly string[]): string => {
  if (arguments_.length !== 2 || arguments_[0] !== '--upload-id')
    throw new Error('Provide exactly --upload-id <UUID>.');
  const parsed = z.string().uuid().safeParse(arguments_[1]);
  if (!parsed.success) throw new Error('--upload-id must be a UUID.');
  return parsed.data;
};

const run = async (): Promise<void> => {
  const [command, ...arguments_] = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === '--help') {
    console.log(help);
    return;
  }
  if (command !== 'retry') throw new Error(help);
  const uploadId = uploadIdFrom(arguments_);
  const database = await import('../db/pool.js');
  closeDatabasePool = database.closeDatabasePool;
  const { databasePool } = database;
  const result = await new PostgresVideoAdminRepository(
    databasePool,
  ).requeueQuarantinedVerification(uploadId, new Date());
  if (result !== 'requeued')
    throw new Error('Quarantined upload was not found or its workout already has a live upload.');
  console.log('Kinetra quarantined video upload requeued.', { uploadId, status: 'success' });
};

void run()
  .catch((caught: unknown) => {
    console.error(caught instanceof Error ? caught.message : 'Video upload recovery failed.');
    process.exitCode = 1;
  })
  .finally(async () => closeDatabasePool?.());
