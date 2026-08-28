import { z } from 'zod';

import { SystemClock } from '../auth/service.js';
import { closeDatabasePool, databasePool } from '../db/pool.js';
import { PostgresTrainerVerificationRepository } from './postgres-trainer-verification.repository.js';

const uuidSchema = z.string().uuid();

const help = (command: string | undefined): string =>
  command === 'grant'
    ? 'Usage: grant --user-id <UUID>'
    : command === 'revoke'
      ? 'Usage: revoke --user-id <UUID>'
      : 'Usage: <grant|revoke> --user-id <UUID>';

const parseUserId = (arguments_: readonly string[]): string => {
  if (arguments_.length !== 2 || arguments_[0] !== '--user-id') {
    throw new Error('Provide exactly --user-id <UUID>.');
  }
  const parsed = uuidSchema.safeParse(arguments_[1]);
  if (!parsed.success) throw new Error('--user-id must be a UUID.');
  return parsed.data;
};

const run = async (): Promise<void> => {
  const [command, ...arguments_] = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === '--help') {
    console.log(help(command));
    return;
  }
  if (command !== 'grant' && command !== 'revoke') throw new Error(help(command));

  const userId = parseUserId(arguments_);
  const repository = new PostgresTrainerVerificationRepository(databasePool);
  const result =
    command === 'grant'
      ? await repository.grantReviewer(userId, new SystemClock().now())
      : await repository.revokeReviewer(userId);

  if (result !== 'updated') {
    throw new Error(
      command === 'grant'
        ? 'Reviewer grant refused: user was not found.'
        : 'Reviewer revoke refused: reviewer was not found.',
    );
  }

  console.log('Kinetra trainer verification reviewer audit.', {
    action: command,
    status: 'success',
    reviewerUserId: userId,
  });
};

void run()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Reviewer command failed.');
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
