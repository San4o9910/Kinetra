import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runTrainerCli = async (arguments_: readonly string[]): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/backend/src/chat/trainer-cli.ts', ...arguments_],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });

test('trainer operator CLI exposes strict grant, reassign and revoke argument contracts', async () => {
  const helpCases = [
    ['grant', 'Usage: grant --user-id <UUID> --display-name <NAME> [--default]'],
    [
      'reassign',
      'Usage: reassign --from-user-id <UUID> --to-user-id <UUID> (--all | --conversation-id <UUID> [...])',
    ],
    ['revoke', 'Usage: revoke --user-id <UUID>'],
  ] as const;

  for (const [command, expected] of helpCases) {
    const result = await runTrainerCli([command, '--help']);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim(), expected);
  }

  const invalidGrant = await runTrainerCli([
    'grant',
    '--user-id',
    'not-a-uuid',
    '--display-name',
    'Trainer',
  ]);
  assert.equal(invalidGrant.code, 1);
  assert.equal(invalidGrant.stderr.trim(), '--user-id must be a UUID.');

  const invalidReassign = await runTrainerCli([
    'reassign',
    '--from-user-id',
    randomUUID(),
    '--to-user-id',
    randomUUID(),
    '--all',
    '--conversation-id',
    randomUUID(),
  ]);
  assert.equal(invalidReassign.code, 1);
  assert.equal(
    invalidReassign.stderr.trim(),
    'Provide exactly one of --all or repeated --conversation-id.',
  );

  const invalidRevoke = await runTrainerCli(['revoke', '--user-id', randomUUID(), '--default']);
  assert.equal(invalidRevoke.code, 1);
  assert.equal(invalidRevoke.stderr.trim(), 'Unsupported flag --default.');
});
