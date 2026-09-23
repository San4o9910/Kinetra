import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { PostgresFreeBetaAccessChecker } from '../src/program/free-beta-access.js';

test('disabled free beta denies access without querying the database', async () => {
  let queryCount = 0;
  const pool = {
    query: async () => {
      queryCount += 1;
      throw new Error('The disabled feature must not query the database.');
    },
  } as unknown as Pick<Pool, 'query'>;
  const checker = new PostgresFreeBetaAccessChecker(pool, false);

  assert.equal(await checker.hasFreeBetaAccess('existing-user'), false);
  assert.equal(await checker.hasFreeBetaAccess('unknown-user'), false);
  assert.equal(queryCount, 0);
});

test('free beta does not grant access when the database query fails', async () => {
  const failure = new Error('Database unavailable.');
  const pool = {
    query: async () => {
      throw failure;
    },
  } as unknown as Pick<Pool, 'query'>;
  const checker = new PostgresFreeBetaAccessChecker(pool, true);

  await assert.rejects(checker.hasFreeBetaAccess('existing-user'), (error) => error === failure);
});
