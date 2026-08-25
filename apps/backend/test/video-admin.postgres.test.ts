import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import pg from 'pg';

import { PostgresSettingsRepository } from '../src/settings/postgres-settings.repository.js';
import { PostgresVideoAdminRepository } from '../src/video-admin/postgres-video.repository.js';

const databaseUrl = process.env.DATABASE_URL;
const postgresRequired = process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true';
const { Pool } = pg;

interface OriginalVideoRow extends pg.QueryResultRow {
  readonly id: string;
  readonly storage_key: string;
  readonly poster_key: string | null;
  readonly duration_seconds: number;
  readonly media_available: boolean;
  readonly status: string;
  readonly media_revision: string;
  readonly updated_at: Date;
}

if (postgresRequired && databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required because KINETRA_REQUIRE_POSTGRES_TEST=true.');
}

const waitForDatabaseLock = async (
  pool: pg.Pool,
  applicationName: string,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE application_name=$1 AND wait_event_type='Lock'
       LIMIT 1`,
      [applicationName],
    );
    if (waiting.rowCount === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
};

test(
  'T14 PostgreSQL inventory, permission, idempotency and revoke fencing are durable',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false, timeout: 20_000 },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PostgresVideoAdminRepository(pool);
    const trainerUserId = randomUUID();
    const otherTrainerUserId = randomUUID();
    const firstUploadId = randomUUID();
    const secondUploadId = randomUUID();
    const quarantinedUploadId = randomUUID();
    const replacementUploadId = randomUUID();
    const idempotencyKey = randomUUID();
    const secondLeaseToken = randomUUID();
    const now = new Date();
    const objectKey = `videos/workouts/week-12/day-7/${firstUploadId}.mp4`;
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';
    let originalVideo: OriginalVideoRow | null = null;

    try {
      const schema = await pool.query<{
        readonly can_manage_videos: boolean;
        readonly media_revision: boolean;
        readonly rate_retention_index: boolean;
      }>(
        `SELECT
           (SELECT column_default = 'false' FROM information_schema.columns
             WHERE table_schema='public' AND table_name='trainer_profiles'
               AND column_name='can_manage_videos') AS can_manage_videos,
           (SELECT column_default LIKE '0%' FROM information_schema.columns
             WHERE table_schema='public' AND table_name='videos'
               AND column_name='media_revision') AS media_revision,
           to_regclass('public.video_upload_rate_events_retention_idx') IS NOT NULL
             AS rate_retention_index`,
      );
      assert.equal(schema.rows[0]?.can_manage_videos, true);
      assert.equal(schema.rows[0]?.media_revision, true);
      assert.equal(schema.rows[0]?.rate_retention_index, true);

      await pool.query(
        `INSERT INTO users (id,email,password_hash,email_verified,onboarding_status)
         VALUES ($1,$2,$3,true,'active')`,
        [trainerUserId, `video-trainer-${trainerUserId}@example.com`, passwordHash],
      );
      await pool.query(
        `INSERT INTO users (id,email,password_hash,email_verified,onboarding_status)
         VALUES ($1,$2,$3,true,'active')`,
        [otherTrainerUserId, `video-trainer-${otherTrainerUserId}@example.com`, passwordHash],
      );
      await pool.query(
        `INSERT INTO trainer_profiles (user_id,display_name,is_active)
         VALUES ($1,'Video trainer',true)`,
        [trainerUserId],
      );
      await pool.query(
        `INSERT INTO trainer_profiles (
           user_id,display_name,is_active,can_manage_videos
         ) VALUES ($1,'Other video trainer',true,true)`,
        [otherTrainerUserId],
      );
      assert.equal(await repository.getAuthority(trainerUserId), null);
      await pool.query(`UPDATE trainer_profiles SET can_manage_videos=true WHERE user_id=$1`, [
        trainerUserId,
      ]);
      assert.deepEqual(await repository.getAuthority(trainerUserId), {
        userId: trainerUserId,
        displayName: 'Video trainer',
      });

      const inventory = await repository.listProgram();
      assert.equal(inventory.summary.total, 84);
      assert.equal(inventory.weeks.length, 12);
      assert.equal(
        inventory.weeks.every((week) => week.days.length === 7),
        true,
      );
      assert.equal(JSON.stringify(inventory).includes('storage_key'), false);
      originalVideo =
        (
          await pool.query<OriginalVideoRow>(
            `SELECT id,storage_key,poster_key,duration_seconds,media_available,status,
                  media_revision,updated_at
           FROM videos WHERE type='workout' AND week_number=12 AND day_of_week=7`,
          )
        ).rows[0] ?? null;
      assert.notEqual(originalVideo, null);

      assert.equal(await repository.workersAreFresh(now, 300), false);
      await repository.updateHeartbeat('upload_verifier', 'succeeded', now);
      await repository.updateHeartbeat('media_cleanup', 'succeeded', now);
      assert.equal(await repository.workersAreFresh(now, 300), true);
      await pool.query(
        `INSERT INTO video_upload_rate_events (
           trainer_user_id,event_type,reserved_bytes,occurred_at
         )
         SELECT $1,'init',1,TIMESTAMPTZ '1900-01-01 00:00:00+00' +
           (sequence * INTERVAL '1 microsecond')
         FROM generate_series(1,1005) AS sequence`,
        [otherTrainerUserId],
      );
      assert.equal(await repository.finalizeCleanupRun(now, false), true);
      assert.equal(
        Number(
          (
            await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*) AS count FROM video_upload_rate_events
               WHERE trainer_user_id=$1 AND occurred_at < $2 - INTERVAL '2 days'`,
              [otherTrainerUserId, now],
            )
          ).rows[0]?.count ?? 0,
        ),
        5,
      );
      assert.equal(await repository.finalizeCleanupRun(now, false), true);
      assert.equal(
        Number(
          (
            await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*) AS count FROM video_upload_rate_events
               WHERE trainer_user_id=$1 AND occurred_at < $2 - INTERVAL '2 days'`,
              [otherTrainerUserId, now],
            )
          ).rows[0]?.count ?? 0,
        ),
        0,
      );

      const input = {
        uploadId: firstUploadId,
        authority: { userId: trainerUserId, displayName: 'Video trainer' },
        weekNumber: 12,
        dayOfWeek: 7,
        idempotencyKey,
        requestFingerprint: 'a'.repeat(64),
        objectKey,
        sizeBytes: 6_291_456,
        partSizeBytes: 5_242_880,
        partCount: 2,
        expiresAt: new Date(now.getTime() + 6 * 60 * 60 * 1000),
        maxActivePerTrainer: 3,
        now,
      } as const;
      await pool.query(
        `INSERT INTO video_upload_rate_events (
           trainer_user_id,event_type,reserved_bytes,occurred_at
         )
         SELECT $1,'sign',0,$2 - INTERVAL '3 days' -
           (sequence * INTERVAL '1 microsecond')
         FROM generate_series(1,1005) AS sequence`,
        [trainerUserId, now],
      );
      assert.equal((await repository.reserveUpload(input)).kind, 'created');
      assert.equal(
        Number(
          (
            await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*) AS count FROM video_upload_rate_events
               WHERE trainer_user_id=$1 AND occurred_at < $2 - INTERVAL '2 days'`,
              [trainerUserId, now],
            )
          ).rows[0]?.count ?? 0,
        ),
        5,
      );
      assert.equal(
        (await repository.reserveUpload({ ...input, uploadId: randomUUID() })).kind,
        'replayed',
      );
      assert.equal(
        (
          await repository.reserveUpload({
            ...input,
            uploadId: randomUUID(),
            requestFingerprint: 'b'.repeat(64),
          })
        ).kind,
        'conflict',
      );
      assert.equal(
        (
          await repository.reserveUpload({
            ...input,
            uploadId: randomUUID(),
            idempotencyKey: randomUUID(),
            objectKey: `videos/workouts/week-12/day-7/${randomUUID()}.mp4`,
          })
        ).kind,
        'slot_busy',
      );

      assert.equal(
        (await repository.attachMultipart(firstUploadId, 'multipart-first'))?.status,
        'uploading',
      );
      assert.equal(
        await repository.claimPartSignBatch(firstUploadId, trainerUserId, now),
        'allowed',
      );
      assert.equal(
        Number(
          (
            await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*) AS count FROM video_upload_rate_events
               WHERE trainer_user_id=$1 AND occurred_at < $2 - INTERVAL '2 days'`,
              [trainerUserId, now],
            )
          ).rows[0]?.count ?? 0,
        ),
        0,
      );
      await pool.query(
        `INSERT INTO video_upload_rate_events (trainer_user_id,event_type,reserved_bytes,occurred_at)
         SELECT $1,'sign',0,$2 FROM generate_series(1,29)`,
        [trainerUserId, now],
      );
      assert.equal(
        await repository.claimPartSignBatch(firstUploadId, trainerUserId, now),
        'rate_limited',
      );
      await pool.query(
        `DELETE FROM video_upload_rate_events WHERE trainer_user_id=$1 AND event_type='sign'`,
        [trainerUserId],
      );

      const completionClaims = await Promise.all(
        Array.from({ length: 50 }, () =>
          repository.beginCompletion(firstUploadId, trainerUserId, now, 300),
        ),
      );
      assert.equal(completionClaims.filter((claim) => claim.kind === 'claimed').length, 1);
      assert.equal(completionClaims.filter((claim) => claim.kind === 'in_progress').length, 49);
      const firstCompletionToken = completionClaims.find((claim) => claim.kind === 'claimed');
      assert.equal(firstCompletionToken?.kind, 'claimed');
      if (firstCompletionToken?.kind !== 'claimed')
        throw new Error('Expected the first completion claim.');
      assert.equal(
        await repository.renewCompletionLease(
          firstUploadId,
          firstCompletionToken.upload.leaseToken,
          new Date(now.getTime() + 60_000),
          600,
        ),
        true,
      );
      assert.equal(
        (
          await repository.beginCompletion(
            firstUploadId,
            trainerUserId,
            new Date(now.getTime() + 6 * 60_000),
            300,
          )
        ).kind,
        'in_progress',
      );
      await pool.query(
        `UPDATE trainer_video_uploads SET lease_expires_at=$2 - INTERVAL '1 second' WHERE id=$1`,
        [firstUploadId, now],
      );
      const recoveredCompletion = await repository.beginCompletion(
        firstUploadId,
        trainerUserId,
        now,
        300,
      );
      assert.equal(recoveredCompletion.kind, 'claimed');
      if (recoveredCompletion.kind !== 'claimed')
        throw new Error('Expected both completion claims.');
      assert.equal(
        await repository.renewCompletionLease(
          firstUploadId,
          firstCompletionToken.upload.leaseToken,
          now,
          300,
        ),
        false,
      );
      assert.equal(
        await repository.releaseCompletion(
          firstUploadId,
          firstCompletionToken.upload.leaseToken,
          now,
        ),
        null,
      );
      assert.equal(
        await repository.markVerificationPending({
          uploadId: firstUploadId,
          leaseToken: firstCompletionToken.upload.leaseToken,
          sizeBytes: 6_291_456,
          etag: 'etag',
          versionId: 'version-1',
          now,
        }),
        null,
      );
      assert.equal(
        (
          await repository.releaseCompletion(
            firstUploadId,
            recoveredCompletion.upload.leaseToken,
            now,
          )
        )?.status,
        'uploading',
      );
      const finalCompletion = await repository.beginCompletion(
        firstUploadId,
        trainerUserId,
        now,
        300,
      );
      assert.equal(finalCompletion.kind, 'claimed');
      if (finalCompletion.kind !== 'claimed') throw new Error('Expected final completion claim.');
      assert.equal(
        await repository.markVerificationPending({
          uploadId: firstUploadId,
          leaseToken: recoveredCompletion.upload.leaseToken,
          sizeBytes: 6_291_456,
          etag: 'etag',
          versionId: 'version-1',
          now,
        }),
        null,
      );
      assert.equal(
        (
          await repository.markVerificationPending({
            uploadId: firstUploadId,
            leaseToken: finalCompletion.upload.leaseToken,
            sizeBytes: 6_291_456,
            etag: 'etag',
            versionId: 'version-1',
            now,
          })
        )?.status,
        'verification_pending',
      );
      assert.equal(
        (await repository.beginCompletion(firstUploadId, trainerUserId, now, 300)).kind,
        'in_progress',
      );

      const firstVerification = await repository.claimVerification(now, 300);
      assert.notEqual(firstVerification, null);
      if (firstVerification === null) throw new Error('Expected first verification lease.');
      const renewalAt = new Date(now.getTime() + 60_000);
      assert.equal(
        await repository.renewVerificationLease(
          firstUploadId,
          firstVerification.leaseToken,
          renewalAt,
          600,
        ),
        true,
      );
      assert.equal(
        await repository.claimVerification(new Date(now.getTime() + 6 * 60_000), 300),
        null,
      );
      const verificationNow = new Date(now.getTime() + 12 * 60_000);
      const takeover = await repository.claimVerification(verificationNow, 300);
      assert.notEqual(takeover, null);
      if (takeover === null) throw new Error('Expected verification lease takeover.');
      assert.notEqual(takeover.leaseToken, firstVerification.leaseToken);
      assert.equal(
        await repository.retryVerification(
          firstUploadId,
          firstVerification.leaseToken,
          'verification_transient_failure',
          verificationNow,
          verificationNow,
        ),
        false,
      );
      assert.equal(
        await repository.quarantineVerification(
          firstUploadId,
          firstVerification.leaseToken,
          'verification_retry_exhausted',
          verificationNow,
        ),
        false,
      );
      await repository.failVerification(
        firstUploadId,
        firstVerification.leaseToken,
        'invalid_mp4_container',
        verificationNow,
      );
      assert.equal(
        await repository.publishVerified({
          uploadId: firstUploadId,
          leaseToken: firstVerification.leaseToken,
          metadata: {
            actualSizeBytes: 6_291_456,
            sha256: 'b'.repeat(64),
            durationSeconds: 10,
            width: 64,
            height: 64,
            videoCodec: 'h264',
            audioCodec: null,
          },
          graceSeconds: 86_400,
          now: verificationNow,
        }),
        'cancelled',
      );
      const fencedLease = await pool.query<{
        readonly lease_token: string;
        readonly status: string;
      }>(`SELECT lease_token,status FROM trainer_video_uploads WHERE id=$1`, [firstUploadId]);
      assert.deepEqual(fencedLease.rows[0], {
        lease_token: takeover.leaseToken,
        status: 'verifying',
      });
      assert.equal(
        (await repository.beginCompletion(firstUploadId, trainerUserId, verificationNow, 300)).kind,
        'in_progress',
      );
      assert.equal(
        await repository.publishVerified({
          uploadId: firstUploadId,
          leaseToken: takeover.leaseToken,
          metadata: {
            actualSizeBytes: 6_291_456,
            sha256: 'c'.repeat(64),
            durationSeconds: 10,
            width: 64,
            height: 64,
            videoCodec: 'h264',
            audioCodec: null,
          },
          graceSeconds: 86_400,
          now: verificationNow,
        }),
        'published',
      );
      assert.equal(
        (await repository.beginCompletion(firstUploadId, trainerUserId, verificationNow, 300)).kind,
        'in_progress',
      );
      const published = await pool.query<{
        readonly id: string;
        readonly storage_key: string;
        readonly media_available: boolean;
        readonly media_revision: string;
      }>(
        `SELECT id,storage_key,media_available,media_revision FROM videos
         WHERE type='workout' AND week_number=12 AND day_of_week=7`,
      );
      assert.deepEqual(published.rows[0], {
        id: originalVideo!.id,
        storage_key: objectKey,
        media_available: true,
        media_revision: String(Number(originalVideo!.media_revision) + 1),
      });
      assert.equal(
        Number(
          (
            await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*) AS count FROM video_media_deletion_jobs
               WHERE upload_id=$1 AND object_key=$2 AND reason='replaced_media'`,
              [firstUploadId, originalVideo!.storage_key],
            )
          ).rows[0]?.count ?? 0,
        ),
        1,
      );

      const hidden = await repository.unpublish(12, 7, trainerUserId, now);
      assert.equal(hidden.video_id, originalVideo!.id);
      assert.equal(hidden.slot_state, 'hidden');
      const revisionAfterHide = hidden.media.revision;
      const hiddenReplay = await repository.unpublish(12, 7, trainerUserId, now);
      assert.equal(hiddenReplay.media.revision, revisionAfterHide);
      assert.equal(
        (
          await pool.query<{ readonly storage_key: string }>(
            `SELECT storage_key FROM videos WHERE id=$1`,
            [originalVideo!.id],
          )
        ).rows[0]?.storage_key,
        objectKey,
      );

      const secondInput = {
        ...input,
        uploadId: secondUploadId,
        idempotencyKey: randomUUID(),
        requestFingerprint: 'd'.repeat(64),
        objectKey: `videos/workouts/week-12/day-7/${secondUploadId}.mp4`,
      };
      assert.equal((await repository.reserveUpload(secondInput)).kind, 'created');
      await pool.query(
        `UPDATE trainer_video_uploads
         SET status='verifying', lease_token=$2, lease_expires_at=$3 + INTERVAL '5 minutes'
         WHERE id=$1`,
        [secondUploadId, secondLeaseToken, now],
      );
      await pool.query(`UPDATE trainer_profiles SET can_manage_videos=false WHERE user_id=$1`, [
        trainerUserId,
      ]);
      assert.equal(
        await repository.publishVerified({
          uploadId: secondUploadId,
          leaseToken: secondLeaseToken,
          metadata: {
            actualSizeBytes: 6_291_456,
            sha256: 'e'.repeat(64),
            durationSeconds: 10,
            width: 64,
            height: 64,
            videoCodec: 'h264',
            audioCodec: null,
          },
          graceSeconds: 86_400,
          now,
        }),
        'cancelled',
      );
      const fenced = await pool.query<{
        readonly status: string;
        readonly cleanup_jobs: number;
      }>(
        `SELECT upload.status,
                (SELECT COUNT(*)::integer FROM video_media_deletion_jobs job
                 WHERE job.upload_id=upload.id) AS cleanup_jobs
         FROM trainer_video_uploads upload WHERE upload.id=$1`,
        [secondUploadId],
      );
      assert.deepEqual(fenced.rows[0], { status: 'cancelled', cleanup_jobs: 1 });

      await pool.query(`UPDATE trainer_profiles SET can_manage_videos=true WHERE user_id=$1`, [
        trainerUserId,
      ]);
      const quarantineInput = {
        ...input,
        uploadId: quarantinedUploadId,
        weekNumber: 12,
        dayOfWeek: 6,
        idempotencyKey: randomUUID(),
        requestFingerprint: 'f'.repeat(64),
        objectKey: `videos/workouts/week-12/day-6/${quarantinedUploadId}.mp4`,
      };
      assert.equal((await repository.reserveUpload(quarantineInput)).kind, 'created');
      await repository.attachMultipart(quarantinedUploadId, 'multipart-quarantine');
      await pool.query(
        `UPDATE trainer_video_uploads
         SET status='verification_pending', actual_size_bytes=expected_size_bytes,
             completed_at=$2, verification_next_attempt_at=$2,
             s3_etag='quarantine-etag', s3_version_id='quarantine-version'
         WHERE id=$1`,
        [quarantinedUploadId, verificationNow],
      );
      const exhausted = await repository.claimVerification(verificationNow, 300);
      assert.equal(exhausted?.id, quarantinedUploadId);
      if (exhausted === null) throw new Error('Expected exhausted verification claim.');
      assert.equal(
        await repository.retryVerification(
          quarantinedUploadId,
          exhausted.leaseToken,
          'verification_transient_failure',
          new Date(verificationNow.getTime() + 1_000),
          verificationNow,
        ),
        true,
      );
      assert.equal(
        Number(
          (
            await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*) AS count FROM video_media_deletion_jobs WHERE upload_id=$1`,
              [quarantinedUploadId],
            )
          ).rows[0]?.count ?? 0,
        ),
        0,
      );
      assert.equal(await repository.finalizeVerificationRun(verificationNow, false), false);
      const retryAt = new Date(verificationNow.getTime() + 1_000);
      const exhaustedRetry = await repository.claimVerification(retryAt, 300);
      assert.equal(exhaustedRetry?.id, quarantinedUploadId);
      if (exhaustedRetry === null) throw new Error('Expected retried verification claim.');
      assert.equal(
        await repository.quarantineVerification(
          quarantinedUploadId,
          exhaustedRetry.leaseToken,
          'verification_retry_exhausted',
          retryAt,
        ),
        true,
      );
      assert.equal(
        Number(
          (
            await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*) AS count FROM video_media_deletion_jobs WHERE upload_id=$1`,
              [quarantinedUploadId],
            )
          ).rows[0]?.count ?? 0,
        ),
        0,
      );
      const healthNow = new Date(retryAt.getTime() + 60_000);
      assert.equal(await repository.finalizeVerificationRun(healthNow, false), true);
      await repository.updateHeartbeat('media_cleanup', 'succeeded', healthNow);
      assert.equal(await repository.workersAreFresh(healthNow, 300), true);

      const otherAuthority = {
        userId: otherTrainerUserId,
        displayName: 'Other video trainer',
      };
      const replacementInput = {
        ...quarantineInput,
        uploadId: replacementUploadId,
        authority: otherAuthority,
        idempotencyKey: randomUUID(),
        requestFingerprint: '1'.repeat(64),
        objectKey: `videos/workouts/week-12/day-6/${replacementUploadId}.mp4`,
      };
      assert.equal((await repository.reserveUpload(replacementInput)).kind, 'created');
      assert.equal(
        await repository.requeueQuarantinedVerification(quarantinedUploadId, healthNow),
        'slot_busy',
      );
      assert.equal(
        (
          await repository.cancelUpload(
            replacementUploadId,
            otherTrainerUserId,
            healthNow,
            healthNow,
          )
        )?.status,
        'cancelled',
      );
      assert.equal(
        await repository.requeueQuarantinedVerification(quarantinedUploadId, healthNow),
        'requeued',
      );
      assert.equal(
        (await repository.cancelUpload(quarantinedUploadId, trainerUserId, healthNow, healthNow))
          ?.status,
        'cancelled',
      );
      assert.equal(
        Number(
          (
            await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*) AS count FROM video_media_deletion_jobs WHERE upload_id=$1`,
              [quarantinedUploadId],
            )
          ).rows[0]?.count ?? 0,
        ),
        1,
      );

      const failedCleanupJobId = randomUUID();
      const failedCleanupKey = `videos/workouts/week-12/day-5/${randomUUID()}.mp4`;
      await pool.query(
        `INSERT INTO video_media_deletion_jobs (
           id,object_key,s3_version_id,reason,upload_id,requested_at,not_before,next_attempt_at
         ) VALUES ($1,$2,'cleanup-version','replaced_media',$3,$4,$4,$4)`,
        [failedCleanupJobId, failedCleanupKey, firstUploadId, healthNow],
      );
      const failureAt = new Date(healthNow.getTime() + 1_000);
      await repository.retryDeletion(
        failedCleanupJobId,
        'object_cleanup_failed',
        new Date(failureAt.getTime() + 60_000),
      );
      assert.equal(await repository.finalizeCleanupRun(failureAt, true), false);
      assert.equal(await repository.workersAreFresh(failureAt, 300), false);
      const emptyAt = new Date(failureAt.getTime() + 1_000);
      await repository.updateHeartbeat('media_cleanup', 'started', emptyAt);
      assert.equal(await repository.finalizeCleanupRun(emptyAt, false), false);
      assert.equal(await repository.workersAreFresh(emptyAt, 300), false);
      const mixedAt = new Date(emptyAt.getTime() + 1_000);
      assert.equal(await repository.finalizeCleanupRun(mixedAt, true), false);
      assert.equal(await repository.workersAreFresh(mixedAt, 300), false);
      const recoveryAt = new Date(mixedAt.getTime() + 1_000);
      await repository.completeDeletion(failedCleanupJobId, recoveryAt);
      assert.equal(await repository.finalizeCleanupRun(recoveryAt, false), true);
      await repository.updateHeartbeat('upload_verifier', 'succeeded', recoveryAt);
      assert.equal(await repository.workersAreFresh(recoveryAt, 300), true);

      const lockedJobId = randomUUID();
      await pool.query(
        `INSERT INTO video_media_deletion_jobs (
           id,object_key,reason,upload_id,requested_at,not_before,next_attempt_at
         ) VALUES ($1,$2,'replaced_media',$3,$4,$4,$4)`,
        [
          lockedJobId,
          `videos/workouts/week-12/day-5/${randomUUID()}.mp4`,
          firstUploadId,
          recoveryAt,
        ],
      );
      await pool.query(`UPDATE video_media_deletion_jobs SET locked_at=$2 WHERE id=$1`, [
        lockedJobId,
        recoveryAt,
      ]);
      assert.equal(await repository.workersAreFresh(recoveryAt, 300), false);
      await repository.retryDeletion(lockedJobId, 'object_still_referenced', recoveryAt);
      const referencedRecoveryAt = new Date(recoveryAt.getTime() + 1_000);
      assert.equal(await repository.finalizeCleanupRun(referencedRecoveryAt, false), true);
      await repository.updateHeartbeat('upload_verifier', 'succeeded', referencedRecoveryAt);
      assert.equal(await repository.workersAreFresh(referencedRecoveryAt, 300), true);
      console.log('KINETRA_T14_UPLOAD_AUTHORIZATION=PASS');
      console.log('KINETRA_T14_REPLACE_UNPUBLISH=PASS');
      console.log('KINETRA_T14_POSTGRES_INTEGRATION=PASS');
    } finally {
      await pool.query('DELETE FROM video_media_deletion_jobs WHERE upload_id=ANY($1::uuid[])', [
        [firstUploadId, secondUploadId, quarantinedUploadId, replacementUploadId],
      ]);
      await pool.query('DELETE FROM trainer_video_uploads WHERE id=ANY($1::uuid[])', [
        [firstUploadId, secondUploadId, quarantinedUploadId, replacementUploadId],
      ]);
      if (originalVideo !== null) {
        await pool.query(
          `UPDATE videos SET storage_key=$2,poster_key=$3,duration_seconds=$4,
             media_available=$5,status=$6,media_revision=$7,updated_at=$8
           WHERE id=$1`,
          [
            originalVideo.id,
            originalVideo.storage_key,
            originalVideo.poster_key,
            originalVideo.duration_seconds,
            originalVideo.media_available,
            originalVideo.status,
            originalVideo.media_revision,
            originalVideo.updated_at,
          ],
        );
      }
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [
        [trainerUserId, otherTrainerUserId],
      ]);
      await pool.end();
    }
  },
);

test(
  'T14 PostgreSQL account deletion and upload reservation use users-before-profile lock order',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false, timeout: 20_000 },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const suffix = randomUUID();
    const reservationApplicationName = `t14-reserve-${suffix}`;
    const deletionApplicationName = `t14-delete-${suffix}`;
    const observerPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const holderPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const reservationPool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      application_name: reservationApplicationName,
    });
    const deletionPool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      application_name: deletionApplicationName,
    });
    const trainerUserId = randomUUID();
    const uploadId = randomUUID();
    const now = new Date();
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';
    const reservationRepository = new PostgresVideoAdminRepository(reservationPool);
    const settingsRepository = new PostgresSettingsRepository(deletionPool);
    let holder: pg.PoolClient | null = null;
    let holderTransactionOpen = false;
    let reservationPromise: ReturnType<PostgresVideoAdminRepository['reserveUpload']> | null = null;
    let deletionPromise: ReturnType<PostgresSettingsRepository['deleteAccount']> | null = null;

    try {
      await observerPool.query(
        `INSERT INTO users (id,email,password_hash,email_verified,onboarding_status)
         VALUES ($1,$2,$3,true,'active')`,
        [trainerUserId, `video-lock-order-${trainerUserId}@example.com`, passwordHash],
      );
      await observerPool.query(
        `INSERT INTO trainer_profiles (
           user_id,display_name,is_active,can_manage_videos
         ) VALUES ($1,'Lock order trainer',true,true)`,
        [trainerUserId],
      );

      holder = await holderPool.connect();
      await holder.query('BEGIN');
      holderTransactionOpen = true;
      await holder.query(`SELECT user_id FROM trainer_profiles WHERE user_id=$1 FOR UPDATE`, [
        trainerUserId,
      ]);

      reservationPromise = reservationRepository.reserveUpload({
        uploadId,
        authority: { userId: trainerUserId, displayName: 'Lock order trainer' },
        weekNumber: 10,
        dayOfWeek: 7,
        idempotencyKey: randomUUID(),
        requestFingerprint: '2'.repeat(64),
        objectKey: `videos/workouts/week-10/day-7/${uploadId}.mp4`,
        sizeBytes: 6_291_456,
        partSizeBytes: 5_242_880,
        partCount: 2,
        expiresAt: new Date(now.getTime() + 6 * 60 * 60 * 1000),
        maxActivePerTrainer: 3,
        now,
      });
      await waitForDatabaseLock(observerPool, reservationApplicationName);

      deletionPromise = settingsRepository.deleteAccount(trainerUserId);
      await waitForDatabaseLock(observerPool, deletionApplicationName);

      await holder.query('COMMIT');
      holderTransactionOpen = false;
      const [reservation, deletion] = await Promise.all([reservationPromise, deletionPromise]);
      assert.equal(reservation.kind, 'created');
      assert.equal(deletion, 'deleted');
    } finally {
      if (holder !== null) {
        if (holderTransactionOpen) await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      if (reservationPromise !== null || deletionPromise !== null) {
        const pending: Promise<unknown>[] = [];
        if (reservationPromise !== null) pending.push(reservationPromise);
        if (deletionPromise !== null) pending.push(deletionPromise);
        await Promise.allSettled(pending);
      }
      await observerPool.query('DELETE FROM video_media_deletion_jobs WHERE upload_id=$1', [
        uploadId,
      ]);
      await observerPool.query('DELETE FROM trainer_video_uploads WHERE id=$1', [uploadId]);
      await observerPool.query('DELETE FROM users WHERE id=$1', [trainerUserId]);
      await Promise.all([
        observerPool.end(),
        holderPool.end(),
        reservationPool.end(),
        deletionPool.end(),
      ]);
    }
  },
);

test(
  'T14 PostgreSQL expiration fences live completion and reopens cleanup for late materialization',
  { skip: databaseUrl === undefined ? 'DATABASE_URL is not configured.' : false, timeout: 20_000 },
  async () => {
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for the PostgreSQL integration test.');
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const repository = new PostgresVideoAdminRepository(pool);
    const trainerUserId = randomUUID();
    const uploadId = randomUUID();
    const now = new Date();
    const leaseExpiryCheckAt = new Date(now.getTime() + 60_000);
    const expirationAt = new Date(now.getTime() + 6 * 60_000);
    const lastPartUrlExpiry = new Date(now.getTime() + 20 * 60_000);
    const objectKey = `videos/workouts/week-10/day-7/${uploadId}.mp4`;
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012';

    try {
      await pool.query(
        `INSERT INTO users (id,email,password_hash,email_verified,onboarding_status)
         VALUES ($1,$2,$3,true,'active')`,
        [trainerUserId, `video-expiry-${trainerUserId}@example.com`, passwordHash],
      );
      await pool.query(
        `INSERT INTO trainer_profiles (user_id,display_name,is_active,can_manage_videos)
         VALUES ($1,'Expiry trainer',true,true)`,
        [trainerUserId],
      );
      const reserved = await repository.reserveUpload({
        uploadId,
        authority: { userId: trainerUserId, displayName: 'Expiry trainer' },
        weekNumber: 10,
        dayOfWeek: 7,
        idempotencyKey: randomUUID(),
        requestFingerprint: '9'.repeat(64),
        objectKey,
        sizeBytes: 6_291_456,
        partSizeBytes: 5_242_880,
        partCount: 2,
        expiresAt: new Date(now.getTime() + 6 * 60 * 60_000),
        maxActivePerTrainer: 3,
        now,
      });
      assert.equal(reserved.kind, 'created');
      await repository.attachMultipart(uploadId, 'multipart-expiration-race');
      assert.equal(
        await repository.savePartManifest({
          uploadId,
          partNumber: 1,
          expectedSizeBytes: 5_242_880,
          checksumSha256Base64: `${'A'.repeat(43)}=`,
          expiresAt: lastPartUrlExpiry,
        }),
        'created',
      );
      const completion = await repository.beginCompletion(uploadId, trainerUserId, now, 300);
      assert.equal(completion.kind, 'claimed');
      if (completion.kind !== 'claimed') throw new Error('Expected a completion lease.');
      await pool.query(`UPDATE trainer_video_uploads SET expires_at=$2 WHERE id=$1`, [
        uploadId,
        new Date(now.getTime() + 30_000),
      ]);

      assert.equal(await repository.expireUploads(leaseExpiryCheckAt, 120), 0);
      assert.equal(
        (
          await pool.query<{ readonly status: string }>(
            `SELECT status FROM trainer_video_uploads WHERE id=$1`,
            [uploadId],
          )
        ).rows[0]?.status,
        'completing',
      );

      assert.equal(await repository.expireUploads(expirationAt, 120), 1);
      const expired = await pool.query<{
        readonly status: string;
        readonly job_id: string;
        readonly not_before: Date;
      }>(
        `SELECT upload.status, job.id AS job_id, job.not_before
         FROM trainer_video_uploads upload
         JOIN video_media_deletion_jobs job ON job.upload_id=upload.id
         WHERE upload.id=$1 AND job.s3_version_id IS NULL`,
        [uploadId],
      );
      assert.equal(expired.rows[0]?.status, 'expired');
      assert.ok(
        (expired.rows[0]?.not_before.getTime() ?? 0) >= lastPartUrlExpiry.getTime() + 60_000,
      );
      const jobId = expired.rows[0]?.job_id;
      if (jobId === undefined) throw new Error('Expected expiration cleanup job.');

      await repository.completeDeletion(jobId, expirationAt);
      const lateAt = new Date(lastPartUrlExpiry.getTime() + 2 * 60_000);
      assert.equal(
        await repository.markVerificationPending({
          uploadId,
          leaseToken: completion.upload.leaseToken,
          sizeBytes: 6_291_456,
          etag: 'late-unversioned-etag',
          versionId: null,
          now: lateAt,
        }),
        null,
      );
      const reopened = await pool.query<{
        readonly status: string;
        readonly s3_etag: string;
        readonly completed_at: Date | null;
        readonly job_count: string;
      }>(
        `SELECT upload.status, upload.s3_etag, job.completed_at,
                COUNT(*) OVER () AS job_count
         FROM trainer_video_uploads upload
         JOIN video_media_deletion_jobs job ON job.upload_id=upload.id
         WHERE upload.id=$1 AND job.s3_version_id IS NULL`,
        [uploadId],
      );
      assert.deepEqual(reopened.rows[0], {
        status: 'expired',
        s3_etag: 'late-unversioned-etag',
        completed_at: null,
        job_count: '1',
      });

      await repository.completeDeletion(jobId, lateAt);
      assert.equal(
        await repository.markVerificationPending({
          uploadId,
          leaseToken: completion.upload.leaseToken,
          sizeBytes: 6_291_456,
          etag: 'late-unversioned-etag',
          versionId: null,
          now: new Date(lateAt.getTime() + 1_000),
        }),
        null,
      );
      assert.equal(
        Number(
          (
            await pool.query<{ readonly count: string }>(
              `SELECT COUNT(*) AS count FROM video_media_deletion_jobs
               WHERE upload_id=$1 AND s3_version_id IS NULL AND completed_at IS NULL`,
              [uploadId],
            )
          ).rows[0]?.count ?? 0,
        ),
        1,
      );
    } finally {
      await pool.query(`DELETE FROM video_media_deletion_jobs WHERE upload_id=$1`, [uploadId]);
      await pool.query(`DELETE FROM trainer_video_uploads WHERE id=$1`, [uploadId]);
      await pool.query(`DELETE FROM users WHERE id=$1`, [trainerUserId]);
      await pool.end();
    }
  },
);
