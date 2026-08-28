import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresAuthRepository } from '../src/auth/postgres-auth.repository.js';
import { hashOpaqueToken } from '../src/auth/tokens.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

interface MutationHold {
  readonly afterUserLocked: (operation: 'rotate' | 'logout', userId: string) => Promise<void>;
  readonly waitUntilHeld: Promise<void>;
  release(): void;
}

const createMutationHold = (expectedOperation: 'rotate' | 'logout'): MutationHold => {
  let signalHeld!: () => void;
  let releaseLock!: () => void;
  let signaled = false;
  const waitUntilHeld = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  const holdLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  return {
    afterUserLocked: async (operation) => {
      assert.equal(operation, expectedOperation);

      if (!signaled) {
        signaled = true;
        signalHeld();
      }

      await holdLock;
    },
    waitUntilHeld,
    release: releaseLock,
  };
};

const waitForDatabaseLockWaiter = async (
  pool: InstanceType<typeof Pool>,
  applicationName: string,
): Promise<void> => {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const waiters = await pool.query<{ readonly count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_locks AS lock
       JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
       WHERE lock.granted = false
         AND activity.application_name = $1`,
      [applicationName],
    );

    if (Number(waiters.rows[0]?.count ?? '0') >= 1) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  assert.fail('Expected a concurrent auth mutation to wait on the per-user PostgreSQL lock.');
};

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

test(
  'PostgreSQL 17 registration persists requested roles and atomically bridges trainer verification',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL registration integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PostgresAuthRepository(pool);
    const traineeId = randomUUID();
    const trainerId = randomUUID();
    const conflictId = randomUUID();
    const concurrentIds = [randomUUID(), randomUUID()] as const;
    const traineeEmail = `registration-trainee-${traineeId}@example.com`;
    const trainerEmail = `registration-trainer-${trainerId}@example.com`;
    const concurrentEmail = `registration-concurrent-${randomUUID()}@example.com`;
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';
    const now = new Date('2026-08-28T09:00:00.000Z');

    const create = (id: string, email: string, requestedRole: 'trainer' | 'trainee') =>
      repository.createUser({
        id,
        email,
        phone: null,
        passwordHash,
        emailVerified: true,
        requestedRole,
        now,
      });

    try {
      const version = await pool.query<{ readonly server_version_num: string }>(
        "SELECT current_setting('server_version_num') AS server_version_num",
      );
      const serverVersion = Number(version.rows[0]?.server_version_num ?? '0');
      assert.equal(
        serverVersion >= 170_000 && serverVersion < 180_000,
        true,
        `mandatory registration integration gate requires PostgreSQL 17, got ${serverVersion}`,
      );

      assert.equal((await create(traineeId, traineeEmail, 'trainee')).status, 'created');
      assert.equal((await create(trainerId, trainerEmail, 'trainer')).status, 'created');

      const users = await pool.query<{
        readonly id: string;
        readonly requested_role: string;
      }>(
        `SELECT id, requested_role
         FROM users
         WHERE id = ANY($1::uuid[])
         ORDER BY id`,
        [[traineeId, trainerId]],
      );
      assert.deepEqual(
        new Map(users.rows.map((row) => [row.id, row.requested_role] as const)),
        new Map([
          [traineeId, 'trainee'],
          [trainerId, 'trainer'],
        ]),
      );

      const bridge = await pool.query<{
        readonly id: string;
        readonly user_id: string;
        readonly status: string;
        readonly submitted_at: Date | null;
      }>(
        `SELECT id, user_id, status, submitted_at
         FROM trainer_verification_requests
         WHERE user_id = ANY($1::uuid[])
         ORDER BY user_id`,
        [[traineeId, trainerId]],
      );
      assert.equal(bridge.rowCount, 1);
      assert.equal(bridge.rows[0]?.user_id, trainerId);
      assert.equal(bridge.rows[0]?.status, 'pending');
      assert.equal(bridge.rows[0]?.submitted_at, null);

      const event = await pool.query<{
        readonly actor_user_id: string | null;
        readonly from_status: string | null;
        readonly to_status: string;
        readonly reason: string | null;
      }>(
        `SELECT actor_user_id, from_status, to_status, reason
         FROM trainer_verification_events
         WHERE request_id = $1`,
        [bridge.rows[0]?.id],
      );
      assert.deepEqual(event.rows, [
        {
          actor_user_id: trainerId,
          from_status: null,
          to_status: 'pending',
          reason: 'trainer_role_selected',
        },
      ]);

      const authority = await pool.query('SELECT 1 FROM trainer_profiles WHERE user_id = $1', [
        trainerId,
      ]);
      assert.equal(
        authority.rowCount,
        0,
        'requested trainer role must not grant trainer authority',
      );

      const conflict = await create(conflictId, trainerEmail, 'trainer');
      assert.deepEqual(conflict, { status: 'conflict', field: 'email' });
      assert.equal(
        (await pool.query('SELECT 1 FROM users WHERE id = $1', [conflictId])).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM trainer_verification_requests WHERE user_id = $1', [
            conflictId,
          ])
        ).rowCount,
        0,
        'identifier conflict must leave no partial trainer request',
      );

      const concurrent = await Promise.all(
        concurrentIds.map((id) => create(id, concurrentEmail, 'trainer')),
      );
      assert.deepEqual(concurrent.map((result) => result.status).sort(), ['conflict', 'created']);
      const concurrentRows = await pool.query<{ readonly id: string }>(
        'SELECT id FROM users WHERE email = $1',
        [concurrentEmail],
      );
      assert.equal(concurrentRows.rowCount, 1);
      const winnerId = concurrentRows.rows[0]?.id;
      assert.equal(
        (
          await pool.query('SELECT 1 FROM trainer_verification_requests WHERE user_id = $1', [
            winnerId,
          ])
        ).rowCount,
        1,
      );

      console.log('KINETRA_REGISTRATION_ROLES_POSTGRES17=PASS');
      console.log('KINETRA_SQLSTATE_42804_REGRESSION_POSTGRES17=PASS');
    } finally {
      await pool.query(
        `DELETE FROM users
         WHERE id = ANY($1::uuid[])
            OR email = $2`,
        [[traineeId, trainerId, conflictId, ...concurrentIds], concurrentEmail],
      );
      await pool.end();
    }
  },
);

test(
  'PostgreSQL logout revokes only the current session in the signed refresh rotation family',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL auth integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const repository = new PostgresAuthRepository(pool);
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const rootSessionId = randomUUID();
    const middleSessionId = randomUUID();
    const currentSessionId = randomUUID();
    const firstDescendantSessionId = randomUUID();
    const latestDescendantSessionId = randomUUID();
    const directSessionId = randomUUID();
    const unrelatedSessionId = randomUUID();
    const otherUserSessionId = randomUUID();
    const rootHash = hashOpaqueToken(randomUUID());
    const middleHash = hashOpaqueToken(randomUUID());
    const currentHash = hashOpaqueToken(randomUUID());
    const firstDescendantHash = hashOpaqueToken(randomUUID());
    const latestDescendantHash = hashOpaqueToken(randomUUID());
    const directHash = hashOpaqueToken(randomUUID());
    const unrelatedHash = hashOpaqueToken(randomUUID());
    const otherUserHash = hashOpaqueToken(randomUUID());
    const dayZero = new Date('2026-08-01T00:00:00.000Z');
    const dayOne = new Date('2026-08-02T00:00:00.000Z');
    const dayTwo = new Date('2026-08-03T00:00:00.000Z');
    const dayThree = new Date('2026-08-04T00:00:00.000Z');
    const dayFour = new Date('2026-08-05T00:00:00.000Z');
    const logoutAt = new Date('2026-09-01T00:00:00.000Z');
    const expiresAt = new Date('2026-10-01T00:00:00.000Z');
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';

    try {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, email_verified)
         VALUES ($1, $2, $5, true), ($3, $4, $5, true)`,
        [
          userId,
          `auth-family-${userId}@example.com`,
          otherUserId,
          `auth-family-${otherUserId}@example.com`,
          passwordHash,
        ],
      );
      await repository.createRefreshSession({
        id: rootSessionId,
        userId,
        tokenHash: rootHash,
        expiresAt,
        now: dayZero,
      });
      assert.equal(
        (
          await repository.rotateRefreshSession({
            currentTokenHash: rootHash,
            replacement: {
              id: middleSessionId,
              tokenHash: middleHash,
              expiresAt,
              now: dayOne,
            },
            now: dayOne,
          })
        ).status,
        'rotated',
      );
      assert.equal(
        (
          await repository.rotateRefreshSession({
            currentTokenHash: middleHash,
            replacement: {
              id: currentSessionId,
              tokenHash: currentHash,
              expiresAt,
              now: dayTwo,
            },
            now: dayTwo,
          })
        ).status,
        'rotated',
      );
      assert.equal(
        (
          await repository.rotateRefreshSession({
            currentTokenHash: currentHash,
            replacement: {
              id: firstDescendantSessionId,
              tokenHash: firstDescendantHash,
              expiresAt,
              now: dayThree,
            },
            now: dayThree,
          })
        ).status,
        'rotated',
      );
      assert.equal(
        (
          await repository.rotateRefreshSession({
            currentTokenHash: firstDescendantHash,
            replacement: {
              id: latestDescendantSessionId,
              tokenHash: latestDescendantHash,
              expiresAt,
              now: dayFour,
            },
            now: dayFour,
          })
        ).status,
        'rotated',
      );
      await repository.createRefreshSession({
        id: directSessionId,
        userId,
        tokenHash: directHash,
        expiresAt,
        now: dayTwo,
      });
      await repository.createRefreshSession({
        id: unrelatedSessionId,
        userId,
        tokenHash: unrelatedHash,
        expiresAt,
        now: dayTwo,
      });
      await repository.createRefreshSession({
        id: otherUserSessionId,
        userId: otherUserId,
        tokenHash: otherUserHash,
        expiresAt,
        now: dayTwo,
      });

      assert.equal(
        await repository.revokeRefreshSessionInFamily({
          currentTokenHash: currentHash,
          expectedUserId: userId,
          ancestorSessionId: rootSessionId,
          now: logoutAt,
        }),
        true,
        'an ancestor proof must reach the target and every replacement descendant',
      );
      assert.equal(
        await repository.revokeRefreshSessionInFamily({
          currentTokenHash: directHash,
          expectedUserId: userId,
          ancestorSessionId: directSessionId,
          now: logoutAt,
        }),
        true,
        'the current session id itself must be accepted',
      );
      assert.equal(
        await repository.revokeRefreshSessionInFamily({
          currentTokenHash: unrelatedHash,
          expectedUserId: userId,
          ancestorSessionId: rootSessionId,
          now: logoutAt,
        }),
        false,
        'another login family for the same user must survive',
      );
      assert.equal(
        await repository.revokeRefreshSessionInFamily({
          currentTokenHash: otherUserHash,
          expectedUserId: userId,
          ancestorSessionId: rootSessionId,
          now: logoutAt,
        }),
        false,
        'another account must survive',
      );
      assert.equal(
        (
          await repository.rotateRefreshSession({
            currentTokenHash: latestDescendantHash,
            replacement: {
              id: randomUUID(),
              tokenHash: hashOpaqueToken(randomUUID()),
              expiresAt,
              now: logoutAt,
            },
            now: logoutAt,
          })
        ).status,
        'invalid',
        'an intentional logout without a replacement must not trigger a reuse cascade',
      );

      const sessions = await pool.query<{
        readonly id: string;
        readonly revoked_at: Date | null;
      }>(
        `SELECT id, revoked_at
         FROM refresh_tokens
         WHERE id = ANY($1::uuid[])`,
        [
          [
            currentSessionId,
            firstDescendantSessionId,
            latestDescendantSessionId,
            directSessionId,
            unrelatedSessionId,
            otherUserSessionId,
          ],
        ],
      );
      assert.equal(sessions.rowCount, 6);
      const revokedById = new Map(sessions.rows.map((row) => [row.id, row.revoked_at] as const));
      assert.notEqual(revokedById.get(currentSessionId), null);
      assert.notEqual(revokedById.get(firstDescendantSessionId), null);
      assert.notEqual(revokedById.get(latestDescendantSessionId), null);
      assert.notEqual(revokedById.get(directSessionId), null);
      assert.equal(revokedById.get(unrelatedSessionId), null);
      assert.equal(revokedById.get(otherUserSessionId), null);
      console.log('KINETRA_AUTH_LOGOUT_FAMILY_POSTGRES=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]);
      await pool.end();
    }
  },
);

test(
  'PostgreSQL serializes refresh rotation and family logout in both lock orders',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL auth integration test.');
    }

    const applicationName = `kinetra-auth-race-${randomUUID()}`;
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      application_name: applicationName,
    });
    const repository = new PostgresAuthRepository(pool);
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const refreshFirstId = randomUUID();
    const refreshFirstReplacementId = randomUUID();
    const logoutFirstId = randomUUID();
    const unrelatedId = randomUUID();
    const otherUserSessionId = randomUUID();
    const rejectedReplacementId = randomUUID();
    const refreshFirstHash = hashOpaqueToken(randomUUID());
    const refreshFirstReplacementHash = hashOpaqueToken(randomUUID());
    const logoutFirstHash = hashOpaqueToken(randomUUID());
    const unrelatedHash = hashOpaqueToken(randomUUID());
    const otherUserHash = hashOpaqueToken(randomUUID());
    const rejectedReplacementHash = hashOpaqueToken(randomUUID());
    const now = new Date('2026-08-05T00:00:00.000Z');
    const raceAt = new Date('2026-08-06T00:00:00.000Z');
    const expiresAt = new Date('2026-10-01T00:00:00.000Z');
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';

    try {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, email_verified)
         VALUES ($1, $2, $5, true), ($3, $4, $5, true)`,
        [
          userId,
          `auth-race-${userId}@example.com`,
          otherUserId,
          `auth-race-${otherUserId}@example.com`,
          passwordHash,
        ],
      );
      for (const session of [
        { id: refreshFirstId, userId, tokenHash: refreshFirstHash },
        { id: logoutFirstId, userId, tokenHash: logoutFirstHash },
        { id: unrelatedId, userId, tokenHash: unrelatedHash },
        { id: otherUserSessionId, userId: otherUserId, tokenHash: otherUserHash },
      ]) {
        await repository.createRefreshSession({ ...session, expiresAt, now });
      }

      const refreshFirstHold = createMutationHold('rotate');
      const refreshFirstRepository = new PostgresAuthRepository(pool, {
        afterUserLocked: refreshFirstHold.afterUserLocked,
      });
      const refreshFirst = refreshFirstRepository.rotateRefreshSession({
        currentTokenHash: refreshFirstHash,
        replacement: {
          id: refreshFirstReplacementId,
          tokenHash: refreshFirstReplacementHash,
          expiresAt,
          now: raceAt,
        },
        now: raceAt,
      });
      await refreshFirstHold.waitUntilHeld;
      const queuedLogout = repository.revokeRefreshSessionInFamily({
        currentTokenHash: refreshFirstHash,
        expectedUserId: userId,
        ancestorSessionId: refreshFirstId,
        now: raceAt,
      });
      let refreshFirstWaitError: unknown = null;

      try {
        await waitForDatabaseLockWaiter(pool, applicationName);
      } catch (error) {
        refreshFirstWaitError = error;
      } finally {
        refreshFirstHold.release();
      }

      const [refreshFirstResult, queuedLogoutResult] = await Promise.all([
        refreshFirst,
        queuedLogout,
      ]);

      if (refreshFirstWaitError !== null) {
        throw refreshFirstWaitError;
      }

      assert.equal(refreshFirstResult.status, 'rotated');
      assert.equal(queuedLogoutResult, true);

      const refreshFirstSessions = await pool.query<{
        readonly id: string;
        readonly revoked_at: Date | null;
      }>(
        `SELECT id, revoked_at
         FROM refresh_tokens
         WHERE id = ANY($1::uuid[])`,
        [
          [
            refreshFirstId,
            refreshFirstReplacementId,
            logoutFirstId,
            unrelatedId,
            otherUserSessionId,
          ],
        ],
      );
      assert.equal(refreshFirstSessions.rowCount, 5);
      const refreshFirstRevokedById = new Map(
        refreshFirstSessions.rows.map((row) => [row.id, row.revoked_at] as const),
      );
      assert.notEqual(refreshFirstRevokedById.get(refreshFirstId), null);
      assert.notEqual(
        refreshFirstRevokedById.get(refreshFirstReplacementId),
        null,
        'refresh-first replacement must be revoked by the queued family logout',
      );
      assert.equal(refreshFirstRevokedById.get(logoutFirstId), null);
      assert.equal(refreshFirstRevokedById.get(unrelatedId), null);
      assert.equal(refreshFirstRevokedById.get(otherUserSessionId), null);

      const logoutFirstHold = createMutationHold('logout');
      const logoutFirstRepository = new PostgresAuthRepository(pool, {
        afterUserLocked: logoutFirstHold.afterUserLocked,
      });
      const logoutFirst = logoutFirstRepository.revokeRefreshSessionInFamily({
        currentTokenHash: logoutFirstHash,
        expectedUserId: userId,
        ancestorSessionId: logoutFirstId,
        now: raceAt,
      });
      await logoutFirstHold.waitUntilHeld;
      const queuedRefresh = repository.rotateRefreshSession({
        currentTokenHash: logoutFirstHash,
        replacement: {
          id: rejectedReplacementId,
          tokenHash: rejectedReplacementHash,
          expiresAt,
          now: raceAt,
        },
        now: raceAt,
      });
      let logoutFirstWaitError: unknown = null;

      try {
        await waitForDatabaseLockWaiter(pool, applicationName);
      } catch (error) {
        logoutFirstWaitError = error;
      } finally {
        logoutFirstHold.release();
      }

      const [logoutFirstResult, queuedRefreshResult] = await Promise.all([
        logoutFirst,
        queuedRefresh,
      ]);

      if (logoutFirstWaitError !== null) {
        throw logoutFirstWaitError;
      }

      assert.equal(logoutFirstResult, true);
      assert.equal(
        queuedRefreshResult.status,
        'invalid',
        'logout-first must prevent a queued refresh replacement',
      );

      const logoutFirstSessions = await pool.query<{
        readonly id: string;
        readonly revoked_at: Date | null;
      }>(
        `SELECT id, revoked_at
         FROM refresh_tokens
         WHERE id = ANY($1::uuid[])`,
        [[logoutFirstId, unrelatedId, otherUserSessionId, rejectedReplacementId]],
      );
      assert.equal(logoutFirstSessions.rowCount, 3, 'queued refresh must not insert a replacement');
      const logoutFirstRevokedById = new Map(
        logoutFirstSessions.rows.map((row) => [row.id, row.revoked_at] as const),
      );
      assert.notEqual(logoutFirstRevokedById.get(logoutFirstId), null);
      assert.equal(logoutFirstRevokedById.get(unrelatedId), null);
      assert.equal(logoutFirstRevokedById.get(otherUserSessionId), null);
      console.log('KINETRA_AUTH_REFRESH_LOGOUT_SERIALIZATION=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[userId, otherUserId]]);
      await pool.end();
    }
  },
);
