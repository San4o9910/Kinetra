import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresChatRepository } from '../src/chat/postgres-chat.repository.js';
import { PostgresSettingsRepository } from '../src/settings/postgres-settings.repository.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresTestRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

const createReserveBarrier = (): ((operation: 'send' | 'reserve') => Promise<void>) => {
  let arrivals = 0;
  let openBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    openBarrier = resolve;
  });

  return async (operation) => {
    if (operation !== 'reserve') {
      return;
    }

    arrivals += 1;

    if (arrivals === 2) {
      openBarrier();
    }

    await barrier;
  };
};

const createPhotoIdempotencyHold = (): {
  readonly afterLock: () => Promise<void>;
  readonly waitUntilHeld: Promise<void>;
  readonly release: () => void;
} => {
  let arrivals = 0;
  let signalHeld!: () => void;
  let releaseLock!: () => void;
  const waitUntilHeld = new Promise<void>((resolve) => {
    signalHeld = resolve;
  });
  const holdLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  return {
    afterLock: async () => {
      arrivals += 1;

      if (arrivals === 1) {
        signalHeld();
        await holdLock;
      }
    },
    waitUntilHeld,
    release: releaseLock,
  };
};

if (postgresTestRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

test(
  'PostgreSQL chat ordering, unread, idempotency, photo ownership and deletion queue are transactional',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL chat integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const repository = new PostgresChatRepository(pool);
    const settingsRepository = new PostgresSettingsRepository(pool);
    const lockTimeoutPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const lockTimeoutSettingsRepository = new PostgresSettingsRepository(lockTimeoutPool);
    const clientId = randomUUID();
    const trainerId = randomUUID();
    const secondTrainerId = randomUUID();
    const createRaceClientId = randomUUID();
    const sendRaceClientId = randomUUID();
    const reserveRaceClientId = randomUUID();
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';
    const now = new Date('2026-08-23T10:00:00.000Z');
    let objectKey: string | null = null;
    const cleanupObjectKeys: string[] = [];

    try {
      await pool.query(
        `INSERT INTO users (
           id, email, password_hash, email_verified, onboarding_status, first_name
         )
         VALUES
           ($1, $2, $4, true, 'active', 'Анна'),
           ($3, $5, $4, true, 'survey_pending', NULL),
           ($6, $7, $4, true, 'survey_pending', NULL),
           ($8, $9, $4, true, 'active', 'Гонка сообщений'),
           ($10, $11, $4, true, 'active', 'Гонка фото'),
           ($12, $13, $4, true, 'active', 'Гонка создания')`,
        [
          clientId,
          `chat-client-${clientId}@example.com`,
          trainerId,
          passwordHash,
          `chat-trainer-${trainerId}@example.com`,
          secondTrainerId,
          `chat-trainer-${secondTrainerId}@example.com`,
          sendRaceClientId,
          `chat-send-race-${sendRaceClientId}@example.com`,
          reserveRaceClientId,
          `chat-reserve-race-${reserveRaceClientId}@example.com`,
          createRaceClientId,
          `chat-create-race-${createRaceClientId}@example.com`,
        ],
      );
      await pool.query(
        `INSERT INTO trainer_profiles (
           user_id, display_name, is_active, is_default, created_at, updated_at
         )
         VALUES ($1, 'Тренер Kinetra', true, true, $2, $2),
                ($3, 'Второй тренер', true, false, $2, $2)`,
        [trainerId, now, secondTrainerId],
      );

      await assert.rejects(
        pool.query(`UPDATE trainer_profiles SET is_default = true WHERE user_id = $1`, [
          secondTrainerId,
        ]),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'constraint' in error &&
          (error as { readonly constraint?: unknown }).constraint ===
            'trainer_profiles_one_active_default_idx',
      );

      await lockTimeoutPool.query(`SET lock_timeout = '150ms'`);
      let signalCreateUsersLock!: () => void;
      let releaseCreateUsersLock!: () => void;
      const createUsersLocked = new Promise<void>((resolve) => {
        signalCreateUsersLock = resolve;
      });
      const holdCreateUsersLock = new Promise<void>((resolve) => {
        releaseCreateUsersLock = resolve;
      });
      const createRaceRepository = new PostgresChatRepository(pool, {
        afterAdminUsersLocked: async (operation) => {
          if (operation === 'create') {
            signalCreateUsersLock();
            await holdCreateUsersLock;
          }
        },
      });
      const racingCreate = createRaceRepository.createOrGetConversation(createRaceClientId, now);
      await createUsersLocked;
      try {
        await assert.rejects(
          lockTimeoutSettingsRepository.deleteAccount(trainerId),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { readonly code?: unknown }).code === '55P03',
          'account deletion must wait while conversation creation holds trainer users first',
        );
      } finally {
        releaseCreateUsersLock();
      }
      assert.equal((await racingCreate)?.created, true);

      const sendRaceConversation = await repository.createOrGetConversation(sendRaceClientId, now);
      assert.notEqual(sendRaceConversation, null);
      let signalSendActorLock!: () => void;
      let releaseSendActorLock!: () => void;
      const sendActorLocked = new Promise<void>((resolve) => {
        signalSendActorLock = resolve;
      });
      const holdSendActorLock = new Promise<void>((resolve) => {
        releaseSendActorLock = resolve;
      });
      const sendRaceRepository = new PostgresChatRepository(pool, {
        afterActorLocked: async (operation) => {
          if (operation === 'send') {
            signalSendActorLock();
            await holdSendActorLock;
          }
        },
      });
      const racingSend = sendRaceRepository.sendMessage({
        userId: sendRaceClientId,
        conversationId: sendRaceConversation!.conversation.id,
        clientMessageId: randomUUID(),
        requestFingerprint: '9'.repeat(64),
        kind: 'text',
        body: 'Порядок блокировок user → conversation',
        photoId: null,
        now,
      });
      await sendActorLocked;
      try {
        await assert.rejects(
          lockTimeoutSettingsRepository.deleteAccount(sendRaceClientId),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { readonly code?: unknown }).code === '55P03',
          'account deletion must wait on the user lock held before the conversation lock',
        );
      } finally {
        releaseSendActorLock();
      }
      assert.equal((await racingSend).kind, 'created');
      assert.equal(await settingsRepository.deleteAccount(sendRaceClientId), 'deleted');

      const reserveRaceConversation = await repository.createOrGetConversation(
        reserveRaceClientId,
        now,
      );
      assert.notEqual(reserveRaceConversation, null);
      const raceObjectKey = `chat/test/${randomUUID()}.webp`;
      cleanupObjectKeys.push(raceObjectKey);
      let signalReserveActorLock!: () => void;
      let releaseReserveActorLock!: () => void;
      const reserveActorLocked = new Promise<void>((resolve) => {
        signalReserveActorLock = resolve;
      });
      const holdReserveActorLock = new Promise<void>((resolve) => {
        releaseReserveActorLock = resolve;
      });
      const reserveRaceRepository = new PostgresChatRepository(pool, {
        afterActorLocked: async (operation) => {
          if (operation === 'reserve') {
            signalReserveActorLock();
            await holdReserveActorLock;
          }
        },
      });
      const racingReserve = reserveRaceRepository.reservePhoto({
        id: randomUUID(),
        conversationId: reserveRaceConversation!.conversation.id,
        uploaderUserId: reserveRaceClientId,
        clientUploadId: randomUUID(),
        inputSha256: '8'.repeat(64),
        objectKey: raceObjectKey,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        now,
      });
      await reserveActorLocked;
      try {
        await assert.rejects(
          lockTimeoutSettingsRepository.deleteAccount(reserveRaceClientId),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { readonly code?: unknown }).code === '55P03',
          'account deletion must wait on the uploader lock held before the conversation lock',
        );
      } finally {
        releaseReserveActorLock();
      }
      assert.equal((await racingReserve).kind, 'reserved');
      assert.equal(await settingsRepository.deleteAccount(reserveRaceClientId), 'deleted');
      assert.equal(
        (
          await pool.query(`SELECT 1 FROM chat_media_deletion_jobs WHERE object_key = $1`, [
            raceObjectKey,
          ])
        ).rowCount,
        1,
      );

      const concurrent = await Promise.all([
        repository.createOrGetConversation(clientId, now),
        repository.createOrGetConversation(clientId, now),
      ]);
      assert.notEqual(concurrent[0], null);
      assert.notEqual(concurrent[1], null);
      assert.equal(concurrent[0]!.conversation.id, concurrent[1]!.conversation.id);
      assert.equal(concurrent.filter((result) => result?.created).length, 1);
      const conversationId = concurrent[0]!.conversation.id;
      assert.equal(
        (await repository.findTrainerConversation(trainerId, conversationId))?.id,
        conversationId,
      );
      assert.equal(await repository.findTrainerConversation(secondTrainerId, conversationId), null);
      await pool.query(`UPDATE users SET first_name = $2 WHERE id = $1`, [
        clientId,
        'Я'.repeat(255),
      ]);
      assert.equal(
        await repository.grantTrainer({
          userId: clientId,
          displayName: 'Недопустимое повышение клиента',
          makeDefault: false,
          now,
        }),
        'client_conversation',
      );
      assert.equal(await repository.revokeTrainer(trainerId, now), 'assigned');
      const firstClientMessageId = randomUUID();
      const secondClientMessageId = randomUUID();

      const [first, second] = await Promise.all([
        repository.sendMessage({
          userId: clientId,
          conversationId,
          clientMessageId: firstClientMessageId,
          requestFingerprint: 'a'.repeat(64),
          kind: 'text',
          body: 'Первое',
          photoId: null,
          now,
        }),
        repository.sendMessage({
          userId: clientId,
          conversationId,
          clientMessageId: secondClientMessageId,
          requestFingerprint: 'b'.repeat(64),
          kind: 'text',
          body: 'Второе',
          photoId: null,
          now: new Date(now.getTime() + 1),
        }),
      ]);
      assert.equal(first.kind, 'created');
      assert.equal(second.kind, 'created');
      const replay = await repository.sendMessage({
        userId: clientId,
        conversationId,
        clientMessageId: firstClientMessageId,
        requestFingerprint: 'a'.repeat(64),
        kind: 'text',
        body: 'Первое',
        photoId: null,
        now: new Date(now.getTime() + 2),
      });
      assert.equal(replay.kind, 'replay');
      const idempotencyConflict = await repository.sendMessage({
        userId: clientId,
        conversationId,
        clientMessageId: firstClientMessageId,
        requestFingerprint: 'e'.repeat(64),
        kind: 'text',
        body: 'Подмена',
        photoId: null,
        now: new Date(now.getTime() + 3),
      });
      assert.deepEqual(idempotencyConflict, { kind: 'idempotency_conflict' });
      const page = await repository.listMessages({
        userId: trainerId,
        conversationId,
        beforeSequence: null,
        afterSequence: null,
        limit: 30,
      });
      assert.notEqual(page, null);
      assert.deepEqual(
        page!.messages.map((message) => message.sequence),
        [1, 2],
      );
      assert.equal(page!.conversation.trainerUnreadCount, 2);
      assert.equal([...page!.messages[0]!.senderName].length, 120);

      const read = await repository.markRead({
        userId: trainerId,
        conversationId,
        throughSequence: 2,
        now: new Date(now.getTime() + 2),
      });
      assert.equal(read.kind, 'updated');
      assert.equal(read.kind === 'updated' ? read.conversation.trainerUnreadCount : -1, 0);
      const lowerRead = await repository.markRead({
        userId: trainerId,
        conversationId,
        throughSequence: 1,
        now: new Date(now.getTime() + 3),
      });
      assert.equal(lowerRead.kind, 'unchanged');
      assert.equal(
        lowerRead.kind === 'unchanged' ? lowerRead.conversation.trainerLastReadSequence : -1,
        2,
      );
      assert.deepEqual(
        await repository.markRead({
          userId: trainerId,
          conversationId,
          throughSequence: 99,
          now: new Date(now.getTime() + 4),
        }),
        { kind: 'future_cursor' },
      );

      const photoId = randomUUID();
      objectKey = `chat/test/${randomUUID()}.webp`;
      cleanupObjectKeys.push(objectKey);
      const reserved = await repository.reservePhoto({
        id: photoId,
        conversationId,
        uploaderUserId: clientId,
        clientUploadId: randomUUID(),
        inputSha256: 'c'.repeat(64),
        objectKey,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        now,
      });
      assert.equal(reserved.kind, 'reserved');
      const foreignReservation = await repository.reservePhoto({
        id: randomUUID(),
        conversationId,
        uploaderUserId: secondTrainerId,
        clientUploadId: randomUUID(),
        inputSha256: 'f'.repeat(64),
        objectKey: `chat/test/${randomUUID()}.webp`,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        now,
      });
      assert.deepEqual(foreignReservation, { kind: 'not_found' });
      const ready = await repository.markPhotoReady({
        photoId,
        uploaderUserId: clientId,
        mimeType: 'image/webp',
        sizeBytes: 128,
        width: 100,
        height: 100,
        now: new Date(now.getTime() + 5),
      });
      assert.equal(ready?.status, 'ready');
      const photoMessage = await repository.sendMessage({
        userId: clientId,
        conversationId,
        clientMessageId: randomUUID(),
        requestFingerprint: 'd'.repeat(64),
        kind: 'photo',
        body: null,
        photoId,
        now: new Date(now.getTime() + 6),
      });
      assert.equal(photoMessage.kind, 'created');
      const secondAttachment = await repository.sendMessage({
        userId: clientId,
        conversationId,
        clientMessageId: randomUUID(),
        requestFingerprint: '1'.repeat(64),
        kind: 'photo',
        body: null,
        photoId,
        now: new Date(now.getTime() + 7),
      });
      assert.deepEqual(secondAttachment, { kind: 'photo_already_attached' });

      const trainerHistory = await repository.sendMessage({
        userId: trainerId,
        conversationId,
        clientMessageId: randomUUID(),
        requestFingerprint: '2'.repeat(64),
        kind: 'text',
        body: 'Историческое сообщение тренера',
        photoId: null,
        now: new Date(now.getTime() + 8),
      });
      assert.equal(trainerHistory.kind, 'created');
      const oldTrainerDraftId = randomUUID();
      const oldTrainerDraftKey = `chat/test/${randomUUID()}.webp`;
      cleanupObjectKeys.push(oldTrainerDraftKey);
      assert.equal(
        (
          await repository.reservePhoto({
            id: oldTrainerDraftId,
            conversationId,
            uploaderUserId: trainerId,
            clientUploadId: randomUUID(),
            inputSha256: '3'.repeat(64),
            objectKey: oldTrainerDraftKey,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
            now: new Date(now.getTime() + 9),
          })
        ).kind,
        'reserved',
      );
      let releaseAuthorizedHistory!: () => void;
      let signalAuthorizedHistory!: () => void;
      const authorizedHistory = new Promise<void>((resolve) => {
        signalAuthorizedHistory = resolve;
      });
      const holdAuthorizedHistory = new Promise<void>((resolve) => {
        releaseAuthorizedHistory = resolve;
      });
      const racingHistoryRepository = new PostgresChatRepository(pool, {
        afterMessagesAuthorized: async () => {
          signalAuthorizedHistory();
          await holdAuthorizedHistory;
        },
      });
      const authorizedOldTrainerRead = racingHistoryRepository.listMessages({
        userId: trainerId,
        conversationId,
        beforeSequence: null,
        afterSequence: null,
        limit: 30,
      });
      await authorizedHistory;
      let signalReassignUsersLock!: () => void;
      let releaseReassignUsersLock!: () => void;
      const reassignUsersLocked = new Promise<void>((resolve) => {
        signalReassignUsersLock = resolve;
      });
      const holdReassignUsersLock = new Promise<void>((resolve) => {
        releaseReassignUsersLock = resolve;
      });
      const reassignRaceRepository = new PostgresChatRepository(pool, {
        afterAdminUsersLocked: async (operation) => {
          if (operation === 'reassign') {
            signalReassignUsersLock();
            await holdReassignUsersLock;
          }
        },
      });
      let reassignmentSettled = false;
      const reassignment = reassignRaceRepository
        .reassignTrainer({
          fromTrainerUserId: trainerId,
          toTrainerUserId: secondTrainerId,
          conversationIds: [conversationId],
          now: new Date(now.getTime() + 10),
        })
        .then((result) => {
          reassignmentSettled = true;
          return result;
        });
      try {
        await reassignUsersLocked;
        try {
          await assert.rejects(
            lockTimeoutSettingsRepository.deleteAccount(secondTrainerId),
            (error: unknown) =>
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              (error as { readonly code?: unknown }).code === '55P03',
            'account deletion must wait while reassignment holds trainer users before profiles',
          );
        } finally {
          releaseReassignUsersLock();
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        assert.equal(
          reassignmentSettled,
          false,
          'reassign waits for authorized history SHARE lock',
        );
      } finally {
        releaseReassignUsersLock();
        releaseAuthorizedHistory();
      }
      assert.notEqual(await authorizedOldTrainerRead, null);
      assert.equal(await reassignment, 1);
      assert.equal(await repository.findTrainerConversation(trainerId, conversationId), null);
      assert.equal(
        (await repository.findTrainerConversation(secondTrainerId, conversationId))?.id,
        conversationId,
      );
      assert.equal(await repository.findPhotoStatus(oldTrainerDraftId, trainerId), null);
      assert.equal(
        (
          await pool.query(`SELECT 1 FROM chat_media_deletion_jobs WHERE object_key = $1`, [
            oldTrainerDraftKey,
          ])
        ).rowCount,
        1,
      );
      assert.equal(
        await repository.listMessages({
          userId: trainerId,
          conversationId,
          beforeSequence: null,
          afterSequence: null,
          limit: 30,
        }),
        null,
      );
      assert.notEqual(
        await repository.listMessages({
          userId: secondTrainerId,
          conversationId,
          beforeSequence: null,
          afterSequence: null,
          limit: 30,
        }),
        null,
      );
      assert.equal(await settingsRepository.deleteAccount(trainerId), 'trainer_managed');
      assert.equal(
        (
          await pool.query(`SELECT 1 FROM chat_messages WHERE sender_user_id = $1 LIMIT 1`, [
            trainerId,
          ])
        ).rowCount,
        1,
      );
      assert.equal(
        await repository.reassignTrainer({
          fromTrainerUserId: trainerId,
          toTrainerUserId: secondTrainerId,
          conversationIds: null,
          now: new Date(now.getTime() + 11),
        }),
        1,
      );
      assert.equal(
        await repository.revokeTrainer(trainerId, new Date(now.getTime() + 12)),
        'default',
      );
      assert.equal(
        await repository.grantTrainer({
          userId: secondTrainerId,
          displayName: 'Второй тренер',
          makeDefault: true,
          now: new Date(now.getTime() + 13),
        }),
        'granted',
      );
      assert.equal(
        await repository.revokeTrainer(trainerId, new Date(now.getTime() + 14)),
        'revoked',
      );

      const unicodeControlMessage = await repository.sendMessage({
        userId: clientId,
        conversationId,
        clientMessageId: randomUUID(),
        requestFingerprint: '4'.repeat(64),
        kind: 'text',
        body: 'до\u0085после',
        photoId: null,
        now: new Date(now.getTime() + 15),
      });
      assert.equal(unicodeControlMessage.kind, 'created');
      assert.equal(
        unicodeControlMessage.kind === 'created' ? unicodeControlMessage.message.body : null,
        'до\u0085после',
        'the database constraint must permit U+0085 just like the shared canonicalizer',
      );

      await pool.query('DELETE FROM users WHERE id = $1', [clientId]);
      const deletedData = await pool.query<{ readonly count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM chat_conversations
         WHERE client_user_id = $1`,
        [clientId],
      );
      assert.equal(deletedData.rows[0]?.count, '0');
      const deletionJob = await pool.query<{ readonly object_key: string }>(
        `SELECT object_key FROM chat_media_deletion_jobs WHERE object_key = $1`,
        [objectKey],
      );
      assert.equal(deletionJob.rows[0]?.object_key, objectKey);
      const claimAt = new Date(Math.max(Date.now(), now.getTime()) + 60_000);
      const [firstClaim, secondClaim] = await Promise.all([
        repository.claimMediaDeletionJobs(claimAt, 10),
        repository.claimMediaDeletionJobs(claimAt, 10),
      ]);
      assert.equal(
        [...firstClaim, ...secondClaim].filter((job) => job.objectKey === objectKey).length,
        1,
      );
      await repository.completeMediaDeletion(objectKey, new Date(claimAt.getTime() + 1));
      await repository.completeMediaDeletion(objectKey, new Date(claimAt.getTime() + 1));
      assert.equal(
        (await repository.claimMediaDeletionJobs(new Date(claimAt.getTime() + 2), 10)).some(
          (job) => job.objectKey === objectKey,
        ),
        false,
      );

      console.log('KINETRA_T12_POSTGRES_INTEGRATION=PASS');
    } finally {
      if (cleanupObjectKeys.length > 0) {
        await pool.query(
          'DELETE FROM chat_media_deletion_jobs WHERE object_key = ANY($1::text[])',
          [cleanupObjectKeys],
        );
      }
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        [
          clientId,
          trainerId,
          secondTrainerId,
          createRaceClientId,
          sendRaceClientId,
          reserveRaceClientId,
        ],
      ]);
      await lockTimeoutPool.end();
      await pool.end();
    }
  },
);

test(
  'PostgreSQL serializes a trainer photo upload key across assigned conversations',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL chat integration test.');
    }

    const applicationName = `kinetra-photo-${randomUUID()}`;
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      application_name: applicationName,
    });
    const trainerId = randomUUID();
    const firstClientId = randomUUID();
    const secondClientId = randomUUID();
    const firstConversationId = randomUUID();
    const secondConversationId = randomUUID();
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';
    const now = new Date('2026-08-23T12:00:00.000Z');
    const objectKeys: string[] = [];

    try {
      await pool.query(
        `INSERT INTO users (
           id, email, password_hash, email_verified, onboarding_status, first_name
         )
         VALUES
           ($1, $2, $7, true, 'survey_pending', NULL),
           ($3, $4, $7, true, 'active', 'Первый клиент'),
           ($5, $6, $7, true, 'active', 'Второй клиент')`,
        [
          trainerId,
          `chat-photo-race-trainer-${trainerId}@example.com`,
          firstClientId,
          `chat-photo-race-client-${firstClientId}@example.com`,
          secondClientId,
          `chat-photo-race-client-${secondClientId}@example.com`,
          passwordHash,
        ],
      );
      await pool.query(
        `INSERT INTO trainer_profiles (
           user_id, display_name, is_active, is_default, created_at, updated_at
         )
         VALUES ($1, 'Тренер гонки фото', true, false, $2, $2)`,
        [trainerId, now],
      );
      await pool.query(
        `INSERT INTO chat_conversations (
           id, client_user_id, trainer_user_id, created_at, updated_at
         )
         VALUES ($1, $2, $5, $6, $6),
                ($3, $4, $5, $6, $6)`,
        [firstConversationId, firstClientId, secondConversationId, secondClientId, trainerId, now],
      );

      const assertRace = async (
        firstInputSha256: string,
        secondInputSha256: string,
      ): Promise<void> => {
        const clientUploadId = randomUUID();
        const firstObjectKey = `chat/test/${randomUUID()}.webp`;
        const secondObjectKey = `chat/test/${randomUUID()}.webp`;
        objectKeys.push(firstObjectKey, secondObjectKey);
        const idempotencyHold = createPhotoIdempotencyHold();
        const repository = new PostgresChatRepository(pool, {
          afterActorLocked: createReserveBarrier(),
          afterPhotoIdempotencyLocked: idempotencyHold.afterLock,
        });
        const requests = [
          {
            id: randomUUID(),
            conversationId: firstConversationId,
            uploaderUserId: trainerId,
            clientUploadId,
            inputSha256: firstInputSha256,
            objectKey: firstObjectKey,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
            now,
          },
          {
            id: randomUUID(),
            conversationId: secondConversationId,
            uploaderUserId: trainerId,
            clientUploadId: clientUploadId.toUpperCase(),
            inputSha256: secondInputSha256,
            objectKey: secondObjectKey,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            leaseExpiresAt: new Date(now.getTime() + 5 * 60 * 1000),
            now,
          },
        ] as const;

        const racingReservations = Promise.all([
          repository.reservePhoto(requests[0]),
          repository.reservePhoto(requests[1]),
        ]);
        let waitObservationError: unknown = null;

        try {
          await idempotencyHold.waitUntilHeld;
          const waitDeadline = Date.now() + 5_000;
          let advisoryWaiterObserved = false;

          while (Date.now() < waitDeadline) {
            const waiters = await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*)::text AS count
               FROM pg_locks AS lock
               JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
               WHERE lock.locktype = 'advisory'
                 AND lock.granted = false
                 AND activity.application_name = $1`,
              [applicationName],
            );

            if (Number(waiters.rows[0]?.count ?? '0') >= 1) {
              advisoryWaiterObserved = true;
              break;
            }

            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }

          assert.equal(
            advisoryWaiterObserved,
            true,
            'the second conversation must wait on the global photo idempotency lock',
          );
        } catch (error) {
          waitObservationError = error;
        } finally {
          idempotencyHold.release();
        }

        const results = await racingReservations;

        if (waitObservationError !== null) {
          throw waitObservationError;
        }

        const winnerIndex = results.findIndex((result) => result.kind === 'reserved');
        assert.notEqual(winnerIndex, -1);
        const loserIndex = winnerIndex === 0 ? 1 : 0;
        assert.deepEqual(results[loserIndex], { kind: 'idempotency_conflict' });
        assert.equal(
          results.filter((result) => result.kind === 'reserved').length,
          1,
          'exactly one reservation wins without exposing a unique-constraint error',
        );

        const persisted = await pool.query<{
          readonly conversation_id: string;
          readonly input_sha256: string;
          readonly object_key: string;
        }>(
          `SELECT conversation_id, input_sha256, object_key
           FROM chat_photos
           WHERE uploader_user_id = $1 AND client_upload_id = $2`,
          [trainerId, clientUploadId],
        );
        assert.equal(persisted.rowCount, 1);
        assert.deepEqual(persisted.rows[0], {
          conversation_id: requests[winnerIndex]!.conversationId,
          input_sha256: requests[winnerIndex]!.inputSha256,
          object_key: requests[winnerIndex]!.objectKey,
        });
      };

      await assertRace('a'.repeat(64), 'a'.repeat(64));
      await assertRace('b'.repeat(64), 'c'.repeat(64));
    } finally {
      try {
        await pool.query(`DELETE FROM chat_conversations WHERE id = ANY($1::uuid[])`, [
          [firstConversationId, secondConversationId],
        ]);
        await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
          [trainerId, firstClientId, secondClientId],
        ]);

        if (objectKeys.length > 0) {
          await pool.query(
            `DELETE FROM chat_media_deletion_jobs WHERE object_key = ANY($1::text[])`,
            [objectKeys],
          );
        }
      } finally {
        await pool.end();
      }
    }
  },
);
