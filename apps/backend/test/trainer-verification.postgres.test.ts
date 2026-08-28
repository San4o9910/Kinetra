import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresProfileRepository } from '../src/profile/postgres-profile.repository.js';
import type { TrainerVerificationApplicationInputRecord } from '../src/trainer-verification/repository.js';
import { PostgresTrainerVerificationRepository } from '../src/trainer-verification/postgres-trainer-verification.repository.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

const PASSWORD_HASH = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';

const application = (
  suffix: string,
  title = 'Professional profile',
): TrainerVerificationApplicationInputRecord => ({
  displayName: `Trainer ${suffix}`,
  specialization: 'Mobility and strength',
  experienceYears: 8,
  bio: `Professional trainer biography for ${suffix} with enough detail.`,
  city: 'Moscow',
  timezone: 'Europe/Moscow',
  materials: [
    {
      kind: 'professional_profile',
      url: `https://example.com/trainers/${suffix}`,
      title,
      issuedAt: '2020-01-01',
      expiresAt: null,
    },
  ],
});

const insertUser = async (
  pool: InstanceType<typeof Pool>,
  userId: string,
  requestedRole: 'trainer' | 'trainee',
  emailVerified = true,
): Promise<void> => {
  await pool.query(
    `INSERT INTO users (
       id, email, password_hash, email_verified, email_verified_at, requested_role
     ) VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN NOW() ELSE NULL END, $5)`,
    [userId, `verification-${userId}@example.com`, PASSWORD_HASH, emailVerified, requestedRole],
  );
};

const insertBridge = async (
  pool: InstanceType<typeof Pool>,
  userId: string,
  now: Date,
): Promise<string> => {
  const request = await pool.query<{ readonly id: string }>(
    `INSERT INTO trainer_verification_requests (
       user_id, status, submitted_at, created_at, updated_at
     ) VALUES ($1, 'pending', NULL, $2, $2)
     RETURNING id`,
    [userId, now],
  );
  const requestId = request.rows[0]?.id;
  assert.equal(typeof requestId, 'string');
  await pool.query(
    `INSERT INTO trainer_verification_events (
       request_id, actor_user_id, from_status, to_status, reason, created_at
     ) VALUES ($1, $2, NULL, 'pending', 'trainer_role_selected', $3)`,
    [requestId, userId, now],
  );
  return requestId as string;
};

const rejectsSqlState = async (promise: Promise<unknown>, sqlState: string): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    if (typeof error !== 'object' || error === null || !('code' in error)) return false;
    return (error as { readonly code?: unknown }).code === sqlState;
  });
};

test(
  'PostgreSQL 17 migration 013 backfills roles, applies defaults and is rerunnable',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for trainer verification PostgreSQL tests.');
    }

    const schemaName = `tv_migration_${randomUUID().replaceAll('-', '')}`;
    const quotedSchemaName = `"${schemaName}"`;
    const traineeId = randomUUID();
    const trainerId = randomUUID();
    const defaultedId = randomUUID();
    const alignedId = randomUUID();
    const migrationSql = await readFile(
      new URL('../migrations/013_trainer_verification.sql', import.meta.url),
      'utf8',
    );
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();

    try {
      const version = await client.query<{ readonly server_version_num: string }>(
        "SELECT current_setting('server_version_num') AS server_version_num",
      );
      const serverVersion = Number(version.rows[0]?.server_version_num ?? '0');
      assert.equal(
        serverVersion >= 170_000 && serverVersion < 180_000,
        true,
        `mandatory migration gate requires PostgreSQL 17, got ${serverVersion}`,
      );

      await client.query(`CREATE SCHEMA ${quotedSchemaName}`);
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${quotedSchemaName}, public`);
      await client.query(`
        CREATE TABLE users (
          id uuid PRIMARY KEY
        );

        CREATE TABLE trainer_profiles (
          user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          is_active boolean NOT NULL DEFAULT false
        );

        CREATE FUNCTION set_updated_at()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $function$;
      `);
      await client.query('INSERT INTO users (id) VALUES ($1), ($2)', [traineeId, trainerId]);
      await client.query('INSERT INTO trainer_profiles (user_id, is_active) VALUES ($1, true)', [
        trainerId,
      ]);

      await client.query(migrationSql);
      await client.query(migrationSql);

      const backfilled = await client.query<{
        readonly id: string;
        readonly requested_role: string;
      }>('SELECT id, requested_role FROM users ORDER BY id');
      assert.deepEqual(
        new Map(backfilled.rows.map((row) => [row.id, row.requested_role] as const)),
        new Map([
          [traineeId, 'trainee'],
          [trainerId, 'trainer'],
        ]),
      );

      const column = await client.query<{
        readonly column_default: string | null;
        readonly is_nullable: string;
        readonly character_maximum_length: number | null;
      }>(
        `SELECT column_default, is_nullable, character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'users'
           AND column_name = 'requested_role'`,
        [schemaName],
      );
      assert.deepEqual(column.rows, [
        {
          column_default: "'trainee'::character varying",
          is_nullable: 'NO',
          character_maximum_length: 16,
        },
      ]);
      const roleConstraint = await client.query<{ readonly definition: string }>(
        `SELECT pg_get_constraintdef(constraint_record.oid) AS definition
         FROM pg_constraint AS constraint_record
         WHERE constraint_record.conname = 'users_requested_role_valid'
           AND constraint_record.conrelid = 'users'::regclass`,
      );
      assert.equal(roleConstraint.rows[0]?.definition.includes("'trainer'"), true);
      assert.equal(roleConstraint.rows[0]?.definition.includes("'trainee'"), true);

      await client.query('INSERT INTO users (id) VALUES ($1), ($2)', [defaultedId, alignedId]);
      await client.query('INSERT INTO trainer_profiles (user_id, is_active) VALUES ($1, false)', [
        alignedId,
      ]);
      await client.query('UPDATE trainer_profiles SET is_active = true WHERE user_id = $1', [
        alignedId,
      ]);
      const postMigrationRoles = await client.query<{
        readonly id: string;
        readonly requested_role: string;
      }>('SELECT id, requested_role FROM users WHERE id = ANY($1::uuid[]) ORDER BY id', [
        [defaultedId, alignedId],
      ]);
      assert.deepEqual(
        new Map(postMigrationRoles.rows.map((row) => [row.id, row.requested_role] as const)),
        new Map([
          [defaultedId, 'trainee'],
          [alignedId, 'trainer'],
        ]),
      );

      await client.query('ROLLBACK');
      console.log('KINETRA_TRAINER_VERIFICATION_MIGRATION_POSTGRES17=PASS');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client
        .query(`DROP SCHEMA IF EXISTS ${quotedSchemaName} CASCADE`)
        .catch(() => undefined);
      client.release();
      await pool.end();
    }
  },
);

test(
  'PostgreSQL 17 trainer verification lifecycle is transactional, authorized and idempotent',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for trainer verification PostgreSQL tests.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const repository = new PostgresTrainerVerificationRepository(pool);
    const applicantId = randomUUID();
    const reviewerId = randomUUID();
    const bridgeAt = new Date('2026-08-28T10:00:00.000Z');
    const submittedAt = new Date('2026-08-28T10:10:00.000Z');
    const infoAt = new Date('2026-08-28T10:20:00.000Z');
    const resubmittedAt = new Date('2026-08-28T10:30:00.000Z');
    const approvedAt = new Date('2026-08-28T10:40:00.000Z');

    try {
      const version = await pool.query<{ readonly server_version_num: string }>(
        "SELECT current_setting('server_version_num') AS server_version_num",
      );
      const serverVersion = Number(version.rows[0]?.server_version_num ?? '0');
      assert.equal(
        serverVersion >= 170_000 && serverVersion < 180_000,
        true,
        `mandatory trainer verification gate requires PostgreSQL 17, got ${serverVersion}`,
      );

      await insertUser(pool, applicantId, 'trainer');
      await insertUser(pool, reviewerId, 'trainee');
      const requestId = await insertBridge(pool, applicantId, bridgeAt);
      assert.equal(await repository.grantReviewer(reviewerId, bridgeAt), 'updated');

      const initial = await repository.findForUser(applicantId);
      assert.equal(initial?.requestedRole, 'trainer');
      assert.equal(initial?.hasActiveTrainerProfile, false);
      assert.equal(initial?.request?.id, requestId);
      assert.equal(initial?.request?.submittedAt, null);

      const submitted = await repository.submit(applicantId, application('lifecycle'), submittedAt);
      assert.equal(submitted.status, 'ok');
      assert.equal(submitted.status === 'ok' ? submitted.value.request?.id : null, requestId);
      assert.equal(submitted.status === 'ok' ? submitted.value.request?.materials.length : null, 1);
      assert.equal(
        (await pool.query('SELECT 1 FROM trainer_profiles WHERE user_id = $1', [applicantId]))
          .rowCount,
        0,
        'pending verification must not grant trainer authority',
      );

      await rejectsSqlState(
        pool.query(
          `INSERT INTO trainer_verification_requests (
             user_id, status, display_name, specialization, experience_years,
             bio, city, timezone, submitted_at
           ) VALUES (
             $1, 'pending', 'Duplicate Active', 'Mobility', 5,
             'Duplicate active application used to isolate the unique index.',
             'Moscow', 'Europe/Moscow', NOW()
           )`,
          [applicantId],
        ),
        '23505',
      );

      assert.equal((await repository.listForReviewer(randomUUID(), null)).status, 'not_reviewer');
      const queue = await repository.listForReviewer(reviewerId, 'pending');
      assert.equal(queue.status, 'ok');
      assert.equal(queue.status === 'ok' ? queue.requests.length : 0, 1);

      const needsInfo = await repository.review(
        reviewerId,
        requestId,
        'request_info',
        'Attach a current certificate.',
        infoAt,
      );
      assert.equal(needsInfo.status, 'ok');
      assert.equal(needsInfo.status === 'ok' ? needsInfo.request.status : null, 'needs_more_info');

      const updated = await repository.update(
        applicantId,
        application('lifecycle-updated', 'Updated professional profile'),
        resubmittedAt,
      );
      assert.equal(updated.status, 'ok');
      assert.equal(updated.status === 'ok' ? updated.value.request?.status : null, 'pending');
      assert.equal(
        updated.status === 'ok' ? updated.value.request?.materials[0]?.title : null,
        'Updated professional profile',
      );

      const approvals = await Promise.all([
        repository.review(reviewerId, requestId, 'approve', null, approvedAt),
        repository.review(reviewerId, requestId, 'approve', null, approvedAt),
      ]);
      assert.deepEqual(
        approvals.map((result) => result.status),
        ['ok', 'ok'],
        'concurrent approval must be idempotent',
      );
      assert.deepEqual(
        approvals.map((result) => (result.status === 'ok' ? result.request.status : null)),
        ['approved', 'approved'],
      );

      const profile = await pool.query<{
        readonly is_active: boolean;
        readonly is_default: boolean;
        readonly can_manage_videos: boolean;
      }>(
        `SELECT is_active, is_default, can_manage_videos
         FROM trainer_profiles
         WHERE user_id = $1`,
        [applicantId],
      );
      assert.deepEqual(profile.rows, [
        { is_active: true, is_default: false, can_manage_videos: false },
      ]);
      assert.equal((await repository.findForUser(applicantId))?.hasActiveTrainerProfile, true);

      const approvedEvents = await pool.query<{ readonly count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM trainer_verification_events
         WHERE request_id = $1 AND to_status = 'approved'`,
        [requestId],
      );
      assert.equal(approvedEvents.rows[0]?.count, '1');

      const repeated = await repository.review(
        reviewerId,
        requestId,
        'approve',
        null,
        new Date('2026-08-28T10:50:00.000Z'),
      );
      assert.equal(repeated.status, 'ok');
      assert.equal(
        (
          await pool.query(
            `SELECT COUNT(*)::text AS count
             FROM trainer_profiles
             WHERE user_id = $1`,
            [applicantId],
          )
        ).rows[0]?.count,
        '1',
      );

      assert.equal(await repository.revokeReviewer(reviewerId), 'updated');
      assert.equal((await repository.listForReviewer(reviewerId, null)).status, 'not_reviewer');
      console.log('KINETRA_TRAINER_VERIFICATION_LIFECYCLE_POSTGRES17=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[applicantId, reviewerId]]);
      await pool.end();
    }
  },
);

test(
  'PostgreSQL approval fails closed for self-review, unverified email and client chat history',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for trainer verification PostgreSQL tests.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const repository = new PostgresTrainerVerificationRepository(pool);
    const reviewerId = randomUUID();
    const unverifiedId = randomUUID();
    const chatClientId = randomUUID();
    const existingTrainerId = randomUUID();
    const preservedProfileId = randomUUID();
    const now = new Date('2026-08-28T11:00:00.000Z');

    try {
      await insertUser(pool, reviewerId, 'trainee');
      await insertUser(pool, unverifiedId, 'trainer', false);
      await insertUser(pool, chatClientId, 'trainer');
      await insertUser(pool, existingTrainerId, 'trainer');
      await insertUser(pool, preservedProfileId, 'trainer');
      await pool.query(
        `INSERT INTO trainer_profiles (
           user_id, display_name, is_active, is_default, can_manage_videos
         ) VALUES ($1, 'Existing Trainer', true, false, false)`,
        [existingTrainerId],
      );

      const unverifiedRequestId = await insertBridge(pool, unverifiedId, now);
      const chatRequestId = await insertBridge(pool, chatClientId, now);
      const preservedRequestId = await insertBridge(pool, preservedProfileId, now);
      assert.equal(
        (await repository.submit(unverifiedId, application('unverified'), now)).status,
        'ok',
      );
      assert.equal(
        (await repository.submit(chatClientId, application('chat-client'), now)).status,
        'ok',
      );
      assert.equal(
        (await repository.submit(preservedProfileId, application('preserved-profile'), now)).status,
        'ok',
      );
      await pool.query(
        `INSERT INTO trainer_profiles (
           user_id, display_name, is_active, is_default, can_manage_videos
         ) VALUES ($1, 'Previously Trusted Trainer', false, false, true)`,
        [preservedProfileId],
      );
      await pool.query(
        `INSERT INTO chat_conversations (client_user_id, trainer_user_id)
         VALUES ($1, $2)`,
        [chatClientId, existingTrainerId],
      );
      assert.equal(await repository.grantReviewer(reviewerId, now), 'updated');
      assert.equal(await repository.grantReviewer(unverifiedId, now), 'updated');

      assert.equal(
        (await repository.review(unverifiedId, unverifiedRequestId, 'approve', null, now)).status,
        'self_review',
      );
      assert.equal(
        (await repository.review(reviewerId, unverifiedRequestId, 'approve', null, now)).status,
        'email_not_verified',
      );
      assert.equal(
        (await repository.review(reviewerId, chatRequestId, 'approve', null, now)).status,
        'client_chat_history',
      );
      assert.equal(
        (await repository.review(reviewerId, preservedRequestId, 'approve', null, now)).status,
        'ok',
      );
      assert.deepEqual(
        (
          await pool.query<{
            readonly is_active: boolean;
            readonly is_default: boolean;
            readonly can_manage_videos: boolean;
          }>(
            `SELECT is_active, is_default, can_manage_videos
             FROM trainer_profiles
             WHERE user_id = $1`,
            [preservedProfileId],
          )
        ).rows,
        [{ is_active: true, is_default: false, can_manage_videos: true }],
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM trainer_profiles WHERE user_id = ANY($1::uuid[])', [
            [unverifiedId, chatClientId],
          ])
        ).rowCount,
        0,
      );
      console.log('KINETRA_TRAINER_VERIFICATION_APPROVAL_GUARDS_POSTGRES17=PASS');
    } finally {
      await pool.query('DELETE FROM chat_conversations WHERE client_user_id = $1', [chatClientId]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        [reviewerId, unverifiedId, chatClientId, existingTrainerId, preservedProfileId],
      ]);
      await pool.end();
    }
  },
);

test(
  'PostgreSQL preserves history on reviewer deletion and cascades it on owner deletion',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for trainer verification PostgreSQL tests.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PostgresTrainerVerificationRepository(pool);
    const applicantId = randomUUID();
    const reviewerId = randomUUID();
    const startedAt = new Date('2026-08-28T12:00:00.000Z');

    try {
      await insertUser(pool, applicantId, 'trainer');
      await insertUser(pool, reviewerId, 'trainee');
      const firstId = await insertBridge(pool, applicantId, startedAt);
      await repository.submit(applicantId, application('history-one'), startedAt);
      await repository.grantReviewer(reviewerId, startedAt);
      assert.equal(
        (
          await repository.review(
            reviewerId,
            firstId,
            'reject',
            'Initial credentials were insufficient.',
            new Date('2026-08-28T12:10:00.000Z'),
          )
        ).status,
        'ok',
      );

      const second = await repository.submit(
        applicantId,
        application('history-two'),
        new Date('2026-08-28T12:20:00.000Z'),
      );
      assert.equal(second.status, 'ok');
      const secondId = second.status === 'ok' ? second.value.request?.id : undefined;
      assert.equal(typeof secondId, 'string');
      assert.notEqual(secondId, firstId);
      assert.equal(
        (await repository.withdraw(applicantId, new Date('2026-08-28T12:30:00.000Z'))).status,
        'ok',
      );

      const third = await repository.submit(
        applicantId,
        application('history-three'),
        new Date('2026-08-28T12:40:00.000Z'),
      );
      assert.equal(third.status, 'ok');
      const thirdId = third.status === 'ok' ? third.value.request?.id : undefined;
      assert.equal(typeof thirdId, 'string');
      assert.notEqual(thirdId, firstId);
      assert.notEqual(thirdId, secondId);

      const history = await pool.query<{ readonly status: string }>(
        `SELECT status
         FROM trainer_verification_requests
         WHERE user_id = $1
         ORDER BY created_at, id`,
        [applicantId],
      );
      assert.deepEqual(history.rows.map((row) => row.status).sort(), [
        'pending',
        'rejected',
        'withdrawn',
      ]);

      const event = await pool.query<{ readonly id: string }>(
        `SELECT id
         FROM trainer_verification_events
         WHERE request_id = $1 AND actor_user_id = $2
         LIMIT 1`,
        [firstId, reviewerId],
      );
      const eventId = event.rows[0]?.id;
      assert.equal(typeof eventId, 'string');
      await rejectsSqlState(
        pool.query('UPDATE trainer_verification_events SET reason = $2 WHERE id = $1', [
          eventId,
          'tampered',
        ]),
        '55000',
      );
      await rejectsSqlState(
        pool.query('UPDATE trainer_verification_events SET actor_user_id = NULL WHERE id = $1', [
          eventId,
        ]),
        '55000',
      );
      await rejectsSqlState(
        pool.query('DELETE FROM trainer_verification_events WHERE id = $1', [eventId]),
        '55000',
      );
      await rejectsSqlState(
        pool.query('DELETE FROM trainer_verification_requests WHERE id = $1', [firstId]),
        '55000',
      );

      await pool.query('DELETE FROM users WHERE id = $1', [reviewerId]);
      const preservedRequest = await pool.query<{
        readonly reviewer_user_id: string | null;
        readonly review_reason: string | null;
      }>(
        `SELECT reviewer_user_id, review_reason
         FROM trainer_verification_requests
         WHERE id = $1`,
        [firstId],
      );
      assert.deepEqual(preservedRequest.rows, [
        { reviewer_user_id: null, review_reason: 'Initial credentials were insufficient.' },
      ]);
      const preservedEvent = await pool.query<{
        readonly actor_user_id: string | null;
        readonly reason: string | null;
      }>('SELECT actor_user_id, reason FROM trainer_verification_events WHERE id = $1', [eventId]);
      assert.deepEqual(preservedEvent.rows, [
        { actor_user_id: null, reason: 'Initial credentials were insufficient.' },
      ]);

      await pool.query('DELETE FROM users WHERE id = $1', [applicantId]);
      assert.equal(
        (
          await pool.query(
            `SELECT COUNT(*)::text AS count
             FROM trainer_verification_requests
             WHERE user_id = $1`,
            [applicantId],
          )
        ).rows[0]?.count,
        '0',
      );
      assert.equal(
        (
          await pool.query(
            `SELECT COUNT(*)::text AS count
             FROM trainer_verification_documents
             WHERE request_id = ANY($1::uuid[])`,
            [[firstId, secondId, thirdId]],
          )
        ).rows[0]?.count,
        '0',
      );
      assert.equal(
        (
          await pool.query(
            `SELECT COUNT(*)::text AS count
             FROM trainer_verification_events
             WHERE request_id = ANY($1::uuid[])`,
            [[firstId, secondId, thirdId]],
          )
        ).rows[0]?.count,
        '0',
      );
      console.log('KINETRA_TRAINER_VERIFICATION_AUDIT_CASCADE_POSTGRES17=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[applicantId, reviewerId]]);
      await pool.end();
    }
  },
);

test(
  'PostgreSQL latest request favors a live reapplication when timestamps are identical',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for trainer verification PostgreSQL tests.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const verificationRepository = new PostgresTrainerVerificationRepository(pool);
    const profileRepository = new PostgresProfileRepository(pool);
    const applicantId = randomUUID();
    const requestIdPrefix = randomUUID().slice(0, -2);
    const pendingId = `${requestIdPrefix}01`;
    const withdrawnId = `${requestIdPrefix}fe`;
    const rejectedId = `${requestIdPrefix}ff`;
    const identicalAt = new Date('2026-08-28T13:00:00.000Z');

    try {
      await insertUser(pool, applicantId, 'trainer');
      assert.equal(rejectedId > pendingId, true);
      assert.equal(withdrawnId > pendingId, true);

      await pool.query(
        `INSERT INTO trainer_verification_requests (
           id, user_id, status, display_name, specialization, experience_years,
           bio, city, timezone, submitted_at, reviewed_at, review_reason,
           created_at, updated_at
         ) VALUES
           (
             $2, $1, 'rejected', 'Rejected Trainer', 'Mobility', 4,
             'Rejected historical trainer verification application.',
             'Moscow', 'Europe/Moscow', $5, $5, 'Credentials were insufficient.', $5, $5
           ),
           (
             $3, $1, 'withdrawn', 'Withdrawn Trainer', 'Mobility', 5,
             'Withdrawn historical trainer verification application.',
             'Moscow', 'Europe/Moscow', $5, NULL, NULL, $5, $5
           ),
           (
             $4, $1, 'pending', 'Pending Trainer', 'Mobility', 6,
             'Current pending trainer verification reapplication.',
             'Moscow', 'Europe/Moscow', $5, NULL, NULL, $5, $5
           )`,
        [applicantId, rejectedId, withdrawnId, pendingId, identicalAt],
      );

      const verification = await verificationRepository.findForUser(applicantId);
      assert.equal(verification?.request?.id, pendingId);
      assert.equal(verification?.request?.status, 'pending');

      const profile = await profileRepository.findByUserId(applicantId);
      assert.equal(profile?.trainerVerificationState, 'pending');
      assert.equal(profile?.accountRole, 'client');
      assert.equal(profile?.trainerProfile, null);
      console.log('KINETRA_TRAINER_VERIFICATION_LATEST_REQUEST_POSTGRES17=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [applicantId]);
      await pool.end();
    }
  },
);
