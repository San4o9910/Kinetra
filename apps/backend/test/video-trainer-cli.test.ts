import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../..');
const cliPath = resolve(testDirectory, '../src/video-admin/trainer-access-cli.ts');
const recoveryCliPath = resolve(testDirectory, '../src/video-admin/upload-recovery-cli.ts');

const run = async (
  arguments_: readonly string[],
  path = cliPath,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> =>
  new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path, ...arguments_], {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) =>
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });

test('T14 video trainer CLI exposes strict grant and revoke contracts without database access', async () => {
  for (const command of ['grant', 'revoke'] as const) {
    const result = await run([command, '--help']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim(), `Usage: ${command} --user-id <UUID>`);
  }

  const invalid = await run(['grant', '--user-id', 'not-a-uuid']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stderr.trim(), '--user-id must be a UUID.');

  const extra = await run(['revoke', '--user-id', '00000000-0000-4000-8000-000000000001', '--all']);
  assert.equal(extra.code, 1);
  assert.equal(extra.stderr.trim(), 'Provide exactly --user-id <UUID>.');
});

test('T14 quarantined upload recovery CLI is strict without database access', async () => {
  const helpResult = await run(['retry', '--help'], recoveryCliPath);
  assert.equal(helpResult.code, 0, helpResult.stderr);
  assert.equal(helpResult.stdout.trim(), 'Usage: retry --upload-id <UUID>');

  const invalid = await run(['retry', '--upload-id', 'not-a-uuid'], recoveryCliPath);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stderr.trim(), '--upload-id must be a UUID.');
});
