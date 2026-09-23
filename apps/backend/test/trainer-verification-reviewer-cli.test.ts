import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../..');
const reviewerCliPath = resolve(testDirectory, '../src/trainer-verification/reviewer-cli.ts');
const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

const runReviewerCli = async (
  arguments_: readonly string[],
  commandDatabaseUrl = '',
): Promise<CommandResult> =>
  new Promise<CommandResult>((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', reviewerCliPath, ...arguments_], {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: commandDatabaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });

test('trainer verification reviewer CLI exposes strict grant and revoke arguments', async () => {
  for (const command of ['grant', 'revoke'] as const) {
    const help = await runReviewerCli([command, '--help']);
    assert.equal(help.code, 0, help.stderr);
    assert.equal(help.stderr, '');
    assert.equal(help.stdout.trim(), `Usage: ${command} --user-id <UUID>`);
  }

  const unknown = await runReviewerCli(['promote', '--user-id', randomUUID()]);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stderr.trim(), 'Usage: <grant|revoke> --user-id <UUID>');

  const invalidId = await runReviewerCli(['grant', '--user-id', 'not-a-uuid']);
  assert.equal(invalidId.code, 1);
  assert.equal(invalidId.stderr.trim(), '--user-id must be a UUID.');

  const missingId = await runReviewerCli(['revoke']);
  assert.equal(missingId.code, 1);
  assert.equal(missingId.stderr.trim(), 'Provide exactly --user-id <UUID>.');

  const extra = await runReviewerCli(['grant', '--user-id', randomUUID(), '--admin']);
  assert.equal(extra.code, 1);
  assert.equal(extra.stderr.trim(), 'Provide exactly --user-id <UUID>.');

  for (const command of ['grant', 'revoke']) {
    const result = await runReviewerCli([command, '--user-id', randomUUID()]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'DATABASE_URL must be an explicit PostgreSQL URL.');
  }
});

test(
  'reviewer CLI performs grant and revoke against PostgreSQL 17',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for reviewer CLI PostgreSQL tests.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const userId = randomUUID();

    try {
      await pool.query(
        `INSERT INTO users (
           id, email, password_hash, email_verified, email_verified_at, requested_role
         ) VALUES ($1, $2, $3, true, NOW(), 'trainee')`,
        [
          userId,
          `reviewer-cli-${userId}@example.com`,
          '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
        ],
      );

      const granted = await runReviewerCli(['grant', '--user-id', userId], databaseUrl);
      assert.equal(granted.code, 0, granted.stderr);
      assert.equal(granted.stderr, '');
      assert.match(granted.stdout, /action: 'grant'/u);
      assert.match(granted.stdout, /status: 'success'/u);
      assert.match(granted.stdout, new RegExp(userId, 'u'));
      assert.equal(
        (
          await pool.query('SELECT 1 FROM trainer_verification_reviewers WHERE user_id = $1', [
            userId,
          ])
        ).rowCount,
        1,
      );

      const revoked = await runReviewerCli(['revoke', '--user-id', userId], databaseUrl);
      assert.equal(revoked.code, 0, revoked.stderr);
      assert.equal(revoked.stderr, '');
      assert.match(revoked.stdout, /action: 'revoke'/u);
      assert.equal(
        (
          await pool.query('SELECT 1 FROM trainer_verification_reviewers WHERE user_id = $1', [
            userId,
          ])
        ).rowCount,
        0,
      );
      console.log('KINETRA_TRAINER_VERIFICATION_REVIEWER_CLI_POSTGRES17=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      await pool.end();
    }
  },
);
