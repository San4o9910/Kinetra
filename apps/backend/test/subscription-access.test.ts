import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { PostgresSubscriptionAccessChecker } from '../src/payments/subscription-access.js';

test('subscription entitlement requires a complete current paid period', async () => {
  let sql = '';
  let parameters: readonly unknown[] = [];
  const pool = {
    query: async (queryText: string, values: readonly unknown[]) => {
      sql = queryText;
      parameters = values;
      return { rowCount: 0 };
    },
  } as unknown as Pool;
  const checker = new PostgresSubscriptionAccessChecker(pool);
  const now = new Date('2026-08-21T12:00:00.000Z');

  assert.equal(await checker.hasActiveSubscription('user-1', now), false);
  assert.deepEqual(parameters, ['user-1', now]);
  assert.match(sql, /starts_at IS NOT NULL/u);
  assert.match(sql, /starts_at <= \$2/u);
  assert.match(sql, /expires_at IS NOT NULL/u);
  assert.match(sql, /expires_at > \$2/u);
  assert.doesNotMatch(sql, /IS NULL OR/u);
});
