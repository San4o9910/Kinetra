import { z } from 'zod';

import { SystemClock } from '../auth/service.js';
import { databasePool, closeDatabasePool } from '../db/pool.js';
import { PostgresChatRepository } from './postgres-chat.repository.js';

const uuid = z.string().uuid();

interface ParsedArguments {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
}

const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];

    if (argument === '--default' || argument === '--all') {
      flags.add(argument);
      continue;
    }

    if (argument === undefined || !argument.startsWith('--')) {
      throw new Error('Invalid trainer command arguments.');
    }

    const value = arguments_[index + 1];

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}.`);
    }

    values.set(argument, [...(values.get(argument) ?? []), value]);
    index += 1;
  }

  return { values, flags };
};

const oneValue = (arguments_: ParsedArguments, name: string): string => {
  const values = arguments_.values.get(name);

  if (values?.length !== 1 || values[0] === undefined) {
    throw new Error(`${name} must be provided exactly once.`);
  }

  return values[0];
};

const userId = (arguments_: ParsedArguments, name: string): string => {
  const parsed = uuid.safeParse(oneValue(arguments_, name));

  if (!parsed.success) {
    throw new Error(`${name} must be a UUID.`);
  }

  return parsed.data;
};

const assertOnly = (
  arguments_: ParsedArguments,
  allowedValues: readonly string[],
  allowedFlags: readonly string[],
): void => {
  for (const name of arguments_.values.keys()) {
    if (!allowedValues.includes(name)) {
      throw new Error(`Unsupported argument ${name}.`);
    }
  }

  for (const name of arguments_.flags) {
    if (!allowedFlags.includes(name)) {
      throw new Error(`Unsupported flag ${name}.`);
    }
  }
};

const commandHelp = (command: string | undefined): string | null => {
  if (command === 'grant') {
    return 'Usage: grant --user-id <UUID> --display-name <NAME> [--default]';
  }

  if (command === 'reassign') {
    return 'Usage: reassign --from-user-id <UUID> --to-user-id <UUID> (--all | --conversation-id <UUID> [...])';
  }

  if (command === 'revoke') {
    return 'Usage: revoke --user-id <UUID>';
  }

  return null;
};

const run = async (): Promise<void> => {
  const [command, ...rawArguments] = process.argv.slice(2);

  if (rawArguments.length === 1 && rawArguments[0] === '--help') {
    const help = commandHelp(command);

    if (help === null) {
      throw new Error('Expected trainer command: grant, reassign, or revoke.');
    }

    console.log(help);
    return;
  }

  const arguments_ = parseArguments(rawArguments);
  const repository = new PostgresChatRepository(databasePool);
  const now = new SystemClock().now();

  if (command === 'grant') {
    assertOnly(arguments_, ['--user-id', '--display-name'], ['--default']);
    const displayName = oneValue(arguments_, '--display-name').normalize('NFC').trim();

    if ([...displayName].length < 1 || [...displayName].length > 120) {
      throw new Error('--display-name must contain between 1 and 120 characters.');
    }

    const trainerUserId = userId(arguments_, '--user-id');
    const result = await repository.grantTrainer({
      userId: trainerUserId,
      displayName,
      makeDefault: arguments_.flags.has('--default'),
      now,
    });

    if (result !== 'granted') {
      throw new Error(`Trainer grant refused: ${result}.`);
    }

    console.log('Kinetra trainer lifecycle audit.', {
      action: 'grant',
      status: 'success',
      trainerUserId,
    });
    return;
  }

  if (command === 'reassign') {
    assertOnly(arguments_, ['--from-user-id', '--to-user-id', '--conversation-id'], ['--all']);
    const rawConversationIds = arguments_.values.get('--conversation-id') ?? [];
    const all = arguments_.flags.has('--all');

    if (all === rawConversationIds.length > 0) {
      throw new Error('Provide exactly one of --all or repeated --conversation-id.');
    }

    const conversationIds = rawConversationIds.map((value) => {
      const parsed = uuid.safeParse(value);

      if (!parsed.success) {
        throw new Error('--conversation-id values must be UUIDs.');
      }

      return parsed.data;
    });

    if (new Set(conversationIds).size !== conversationIds.length) {
      throw new Error('--conversation-id values must be unique.');
    }

    const fromTrainerUserId = userId(arguments_, '--from-user-id');
    const toTrainerUserId = userId(arguments_, '--to-user-id');
    const count = await repository.reassignTrainer({
      fromTrainerUserId,
      toTrainerUserId,
      conversationIds: all ? null : conversationIds,
      now,
    });

    if (count === null) {
      throw new Error('Trainer reassignment refused.');
    }

    console.log('Kinetra trainer lifecycle audit.', {
      action: 'reassign',
      status: 'success',
      conversationCount: count,
      fromTrainerUserId,
      toTrainerUserId,
    });
    return;
  }

  if (command === 'revoke') {
    assertOnly(arguments_, ['--user-id'], []);
    const trainerUserId = userId(arguments_, '--user-id');
    const result = await repository.revokeTrainer(trainerUserId, now);

    if (result !== 'revoked') {
      throw new Error(`Trainer revoke refused: ${result}.`);
    }

    console.log('Kinetra trainer lifecycle audit.', {
      action: 'revoke',
      status: 'success',
      trainerUserId,
    });
    return;
  }

  throw new Error('Expected trainer command: grant, reassign, or revoke.');
};

void run()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Trainer command failed.');
    process.exitCode = 1;
  })
  .finally(async () => closeDatabasePool());
