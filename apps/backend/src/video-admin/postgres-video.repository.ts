import type {
  ProgramDirection,
  TrainerVideoProgramResponse,
  TrainerVideoSlotDto,
  TrainerVideoUploadStatus,
} from '@kinetra/shared';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  ClaimedVideoUpload,
  CompletionClaimResult,
  ReserveUploadResult,
  VideoAdminRepository,
  VideoDeletionJob,
  VideoPartManifest,
  VideoTrainerAuthority,
  VideoUploadSnapshot,
} from './repository.js';
import { toUploadDto } from './repository.js';

interface UploadRow extends QueryResultRow {
  readonly id: string;
  readonly target_video_id: string;
  readonly uploader_user_id: string | null;
  readonly week_number: number;
  readonly day_of_week: number;
  readonly object_key: string;
  readonly s3_multipart_upload_id: string | null;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly status: TrainerVideoUploadStatus;
  readonly expected_size_bytes: string | number;
  readonly part_size_bytes: number;
  readonly expected_part_count: number;
  readonly target_media_revision: string | number;
  readonly actual_size_bytes: string | number | null;
  readonly sha256: string | null;
  readonly s3_etag: string | null;
  readonly s3_version_id: string | null;
  readonly duration_seconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly video_codec: string | null;
  readonly audio_codec: string | null;
  readonly last_error_code: string | null;
  readonly expires_at: Date | string;
  readonly completed_at: Date | string | null;
  readonly verified_at: Date | string | null;
  readonly published_at: Date | string | null;
  readonly lease_token?: string;
  readonly lease_expires_at: Date | string | null;
  readonly verification_attempt_count: number;
}

interface SlotRow extends QueryResultRow {
  readonly video_id: string;
  readonly week_number: number;
  readonly week_title: string;
  readonly day_of_week: number;
  readonly direction: ProgramDirection;
  readonly day_title: string;
  readonly duration_minutes: number;
  readonly media_available: boolean;
  readonly media_revision: string | number;
  readonly media_duration_seconds: number;
  readonly media_uploaded_at: Date | string | null;
  readonly has_verified_media: boolean;
}

const UPLOAD_SELECT = `
  SELECT upload.id, upload.target_video_id, upload.uploader_user_id,
         video.week_number, video.day_of_week, upload.object_key,
         upload.s3_multipart_upload_id, upload.idempotency_key,
         upload.request_fingerprint, upload.status, upload.expected_size_bytes,
         upload.part_size_bytes, upload.expected_part_count,
         upload.target_media_revision, upload.actual_size_bytes, upload.sha256,
         upload.s3_etag, upload.s3_version_id, upload.duration_seconds,
         upload.width, upload.height, upload.video_codec, upload.audio_codec,
         upload.last_error_code, upload.expires_at, upload.completed_at,
         upload.verified_at, upload.published_at, upload.lease_token,
         upload.lease_expires_at,
         upload.verification_attempt_count
  FROM trainer_video_uploads AS upload
  JOIN videos AS video ON video.id = upload.target_video_id
`;

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const optionalDate = (value: Date | string | null): Date | null =>
  value === null ? null : asDate(value);
const asNumber = (value: string | number): number => Number(value);
const LEASE_QUERY_TIMEOUT_MS = 5_000;
const RATE_EVENT_PRUNE_LIMIT = 1_000;

const mapUpload = (row: UploadRow): VideoUploadSnapshot => ({
  id: row.id,
  targetVideoId: row.target_video_id,
  uploaderUserId: row.uploader_user_id,
  weekNumber: row.week_number,
  dayOfWeek: row.day_of_week,
  objectKey: row.object_key,
  multipartUploadId: row.s3_multipart_upload_id,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
  status: row.status,
  expectedSizeBytes: asNumber(row.expected_size_bytes),
  partSizeBytes: row.part_size_bytes,
  expectedPartCount: row.expected_part_count,
  targetMediaRevision: asNumber(row.target_media_revision),
  actualSizeBytes: row.actual_size_bytes === null ? null : asNumber(row.actual_size_bytes),
  sha256: row.sha256,
  s3Etag: row.s3_etag,
  s3VersionId: row.s3_version_id,
  durationSeconds: row.duration_seconds,
  width: row.width,
  height: row.height,
  videoCodec: row.video_codec,
  audioCodec: row.audio_codec,
  lastErrorCode: row.last_error_code,
  expiresAt: asDate(row.expires_at),
  completedAt: optionalDate(row.completed_at),
  verifiedAt: optionalDate(row.verified_at),
  publishedAt: optionalDate(row.published_at),
  verificationAttemptCount: row.verification_attempt_count,
});

const rollback = async (client: PoolClient): Promise<void> => {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original failure.
  }
};

const lockVideoTrainerAuthority = async (
  client: PoolClient,
  userId: string,
): Promise<{ readonly displayName: string } | null> => {
  const user = await client.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [userId]);
  if (user.rowCount !== 1) return null;

  const authority = await client.query<{ readonly display_name: string }>(
    `SELECT display_name FROM trainer_profiles
     WHERE user_id=$1 AND is_active=true AND can_manage_videos=true FOR UPDATE`,
    [userId],
  );
  const row = authority.rows[0];
  return row === undefined ? null : { displayName: row.display_name };
};

const pruneVideoUploadRateEvents = async (
  client: PoolClient,
  trainerUserId: string,
  now: Date,
): Promise<void> => {
  await client.query(
    `WITH stale AS (
       SELECT id FROM video_upload_rate_events
       WHERE trainer_user_id=$1 AND occurred_at < $2::timestamptz - INTERVAL '2 days'
       ORDER BY occurred_at, id
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM video_upload_rate_events AS event
     USING stale
     WHERE event.id=stale.id`,
    [trainerUserId, now, RATE_EVENT_PRUNE_LIMIT],
  );
};

const isLive = (status: TrainerVideoUploadStatus): boolean =>
  ['creating', 'uploading', 'completing', 'verification_pending', 'verifying'].includes(status);

const dayLabels = [
  '',
  'Понедельник',
  'Вторник',
  'Среда',
  'Четверг',
  'Пятница',
  'Суббота',
  'Воскресенье',
] as const;

export class PostgresVideoAdminRepository implements VideoAdminRepository {
  public constructor(private readonly pool: Pool) {}

  public async getAuthority(userId: string): Promise<VideoTrainerAuthority | null> {
    const result = await this.pool.query<{
      readonly user_id: string;
      readonly display_name: string;
    }>(
      `SELECT user_id, display_name
       FROM trainer_profiles
       WHERE user_id = $1 AND is_active = true AND can_manage_videos = true`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { userId: row.user_id, displayName: row.display_name };
  }

  public async workersAreFresh(now: Date, maxStaleSeconds: number): Promise<boolean> {
    const result = await this.pool.query<{ readonly fresh: boolean }>(
      `SELECT COUNT(*) = 2
          AND BOOL_AND(
            last_succeeded_at IS NOT NULL
            AND last_succeeded_at >=
              $1::timestamptz - ($2::double precision * INTERVAL '1 second')
          )
          AND BOOL_AND(last_failed_at IS NULL OR last_succeeded_at > last_failed_at)
          AND BOOL_AND(
            last_succeeded_at IS NOT NULL
            AND (last_started_at IS NULL OR last_succeeded_at >= last_started_at)
          )
          AND NOT EXISTS (
            SELECT 1 FROM video_media_deletion_jobs
            WHERE completed_at IS NULL
              AND (
                locked_at IS NOT NULL
                OR COALESCE(last_error_code, '') NOT IN ('', 'object_still_referenced')
              )
          ) AS fresh
       FROM video_worker_heartbeats
       WHERE worker_name IN ('upload_verifier', 'media_cleanup')`,
      [now, maxStaleSeconds],
    );
    return result.rows[0]?.fresh === true;
  }

  public async listProgram(): Promise<TrainerVideoProgramResponse> {
    const [slotsResult, uploadsResult] = await Promise.all([
      this.pool.query<SlotRow>(
        `SELECT video.id AS video_id, week.week_number, week.title AS week_title,
                day.day_of_week, day.direction, day.title AS day_title,
                day.duration_minutes, video.media_available, video.media_revision,
                video.duration_seconds AS media_duration_seconds,
                published.published_at AS media_uploaded_at,
                EXISTS (
                  SELECT 1 FROM trainer_video_uploads verified
                  WHERE verified.target_video_id = video.id AND verified.status = 'published'
                ) AS has_verified_media
         FROM program_weeks AS week
         JOIN program_days AS day ON day.program_week_id = week.id
         JOIN videos AS video
           ON video.type = 'workout'
          AND video.week_number = week.week_number
          AND video.day_of_week = day.day_of_week
         LEFT JOIN LATERAL (
           SELECT upload.published_at
           FROM trainer_video_uploads upload
           WHERE upload.target_video_id = video.id AND upload.status = 'published'
           ORDER BY upload.published_at DESC NULLS LAST, upload.id DESC LIMIT 1
         ) published ON true
         ORDER BY week.week_number, day.day_of_week`,
      ),
      this.pool.query<UploadRow>(
        `${UPLOAD_SELECT}
         WHERE upload.id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY target_video_id
               ORDER BY CASE WHEN status IN ('creating','uploading','completing','verification_pending','verifying') THEN 0 ELSE 1 END,
                        created_at DESC, id DESC
             ) AS position
             FROM trainer_video_uploads
           ) ranked WHERE position <= 2
         )
         ORDER BY upload.target_video_id, upload.created_at DESC`,
      ),
    ]);

    if (slotsResult.rows.length !== 84) {
      throw new Error('Trainer video inventory requires exactly 84 workout slots.');
    }

    const uploads = new Map<string, VideoUploadSnapshot[]>();
    for (const row of uploadsResult.rows) {
      const upload = mapUpload(row);
      uploads.set(upload.targetVideoId, [...(uploads.get(upload.targetVideoId) ?? []), upload]);
    }

    const weeks = new Map<number, { title: string; days: TrainerVideoSlotDto[] }>();
    let available = 0;
    let processing = 0;
    let failed = 0;
    for (const row of slotsResult.rows) {
      const candidates = uploads.get(row.video_id) ?? [];
      const live = candidates.find((upload) => isLive(upload.status)) ?? null;
      const latest = candidates[0] ?? null;
      let slotState: TrainerVideoSlotDto['slot_state'];
      if (live !== null && row.media_available) slotState = 'replacing';
      else if (live !== null && ['creating', 'uploading'].includes(live.status))
        slotState = 'uploading';
      else if (live !== null) slotState = 'processing';
      else if (row.media_available) slotState = 'available';
      else if (row.has_verified_media) slotState = 'hidden';
      else if (
        latest !== null &&
        ['failed', 'expired', 'superseded', 'verification_quarantined'].includes(latest.status)
      )
        slotState = 'failed';
      else slotState = 'empty';

      const hasLatestFailure =
        live === null &&
        latest !== null &&
        ['failed', 'expired', 'superseded', 'verification_quarantined'].includes(latest.status);

      if (row.media_available) available += 1;
      if (
        live !== null &&
        ['completing', 'verification_pending', 'verifying'].includes(live.status)
      )
        processing += 1;
      if (hasLatestFailure) failed += 1;

      const slot: TrainerVideoSlotDto = {
        video_id: row.video_id,
        day_of_week: row.day_of_week,
        day_label: dayLabels[row.day_of_week] ?? `День ${row.day_of_week}`,
        direction: row.direction,
        title: row.day_title,
        duration_minutes: row.duration_minutes,
        media: {
          available: row.media_available,
          revision: asNumber(row.media_revision),
          duration_seconds: row.has_verified_media ? row.media_duration_seconds : null,
          uploaded_at:
            row.media_uploaded_at === null ? null : asDate(row.media_uploaded_at).toISOString(),
        },
        slot_state: slotState,
        live_upload: live === null ? null : toUploadDto(live),
        latest_upload: latest === null ? null : toUploadDto(latest),
      };
      const week = weeks.get(row.week_number) ?? { title: row.week_title, days: [] };
      week.days.push(slot);
      weeks.set(row.week_number, week);
    }

    if (weeks.size !== 12 || [...weeks.values()].some((week) => week.days.length !== 7)) {
      throw new Error('Trainer video inventory curriculum is inconsistent.');
    }

    return {
      summary: { total: 84, available, processing, failed },
      weeks: [...weeks.entries()].map(([week_number, week]) => ({
        week_number,
        title: week.title,
        days: week.days,
      })),
    };
  }

  public async reserveUpload(
    input: Parameters<VideoAdminRepository['reserveUpload']>[0],
  ): Promise<ReserveUploadResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await lockVideoTrainerAuthority(client, input.authority.userId);
      if (authority === null) {
        await client.query('COMMIT');
        return { kind: 'limit' };
      }
      const replay = await client.query<UploadRow>(
        `${UPLOAD_SELECT}
         WHERE upload.uploader_user_id = $1 AND upload.idempotency_key = $2
         LIMIT 1`,
        [input.authority.userId, input.idempotencyKey],
      );
      const replayRow = replay.rows[0];
      if (replayRow !== undefined) {
        await client.query('COMMIT');
        return replayRow.request_fingerprint === input.requestFingerprint
          ? { kind: 'replayed', upload: mapUpload(replayRow) }
          : { kind: 'conflict' };
      }
      await pruneVideoUploadRateEvents(client, input.authority.userId, input.now);
      const slot = await client.query<{
        readonly id: string;
        readonly media_revision: string | number;
      }>(
        `SELECT id, media_revision FROM videos
         WHERE type = 'workout' AND week_number = $1 AND day_of_week = $2
         FOR UPDATE`,
        [input.weekNumber, input.dayOfWeek],
      );
      const slotRow = slot.rows[0];
      if (slotRow === undefined) {
        await client.query('COMMIT');
        return { kind: 'slot_not_found' };
      }
      const limits = await client.query<{
        readonly active_count: string;
        readonly init_count: string;
        readonly reserved_bytes: string;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM trainer_video_uploads
             WHERE uploader_user_id = $1
               AND status IN ('creating','uploading','completing','verification_pending','verifying')) AS active_count,
           COUNT(*) FILTER (WHERE event_type = 'init' AND occurred_at >= $2::timestamptz - INTERVAL '1 hour') AS init_count,
           COALESCE(SUM(reserved_bytes) FILTER (WHERE event_type = 'init' AND occurred_at >= date_trunc('day', $2::timestamptz)), 0) AS reserved_bytes
         FROM video_upload_rate_events WHERE trainer_user_id = $1`,
        [input.authority.userId, input.now],
      );
      const limit = limits.rows[0];
      if (Number(limit?.active_count ?? 0) >= input.maxActivePerTrainer) {
        await client.query('COMMIT');
        return { kind: 'limit' };
      }
      if (
        Number(limit?.init_count ?? 0) >= 10 ||
        Number(limit?.reserved_bytes ?? 0) + input.sizeBytes > 20 * 2_147_483_648
      ) {
        await client.query('COMMIT');
        return { kind: 'rate_limited' };
      }
      const busy = await client.query(
        `SELECT 1 FROM trainer_video_uploads
         WHERE target_video_id = $1
           AND status IN ('creating','uploading','completing','verification_pending','verifying')
         LIMIT 1 FOR UPDATE`,
        [slotRow.id],
      );
      if (busy.rowCount === 1) {
        await client.query('COMMIT');
        return { kind: 'slot_busy' };
      }
      await client.query(
        `INSERT INTO video_upload_rate_events (trainer_user_id, event_type, reserved_bytes, occurred_at)
         VALUES ($1, 'init', $2, $3)`,
        [input.authority.userId, input.sizeBytes, input.now],
      );
      const inserted = await client.query<UploadRow>(
        `INSERT INTO trainer_video_uploads (
           id, target_video_id, uploader_user_id, uploader_display_name_snapshot,
           idempotency_key, request_fingerprint, object_key, declared_mime_type,
           expected_size_bytes, part_size_bytes, expected_part_count,
           target_media_revision, status, expires_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'video/mp4',$8,$9,$10,$11,'creating',$12,$13,$13)
         RETURNING id, target_video_id, uploader_user_id, $14::smallint AS week_number,
           $15::smallint AS day_of_week, object_key, s3_multipart_upload_id,
           idempotency_key, request_fingerprint, status, expected_size_bytes,
           part_size_bytes, expected_part_count, target_media_revision, actual_size_bytes,
           sha256, s3_etag, s3_version_id, duration_seconds, width, height, video_codec,
           audio_codec, last_error_code, expires_at, completed_at, verified_at, published_at,
           lease_token`,
        [
          input.uploadId,
          slotRow.id,
          input.authority.userId,
          authority.displayName,
          input.idempotencyKey,
          input.requestFingerprint,
          input.objectKey,
          input.sizeBytes,
          input.partSizeBytes,
          input.partCount,
          slotRow.media_revision,
          input.expiresAt,
          input.now,
          input.weekNumber,
          input.dayOfWeek,
        ],
      );
      await client.query('COMMIT');
      return { kind: 'created', upload: mapUpload(inserted.rows[0]!) };
    } catch (error) {
      await rollback(client);
      if ((error as { code?: string }).code === '23505') return { kind: 'slot_busy' };
      throw error;
    } finally {
      client.release();
    }
  }

  public async attachMultipart(
    uploadId: string,
    multipartUploadId: string,
  ): Promise<VideoUploadSnapshot | null> {
    const result = await this.pool.query<UploadRow>(
      `WITH changed AS (
         UPDATE trainer_video_uploads SET s3_multipart_upload_id = $2, status = 'uploading'
         WHERE id = $1 AND status = 'creating' RETURNING *
       ) ${UPLOAD_SELECT.replace('FROM trainer_video_uploads AS upload', 'FROM changed AS upload')}`,
      [uploadId, multipartUploadId],
    );
    return result.rows[0] === undefined ? null : mapUpload(result.rows[0]);
  }

  public async failCreating(
    uploadId: string,
    errorCode: string,
    now: Date,
    multipartUploadId: string | null,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<UploadRow>(
        `${UPLOAD_SELECT} WHERE upload.id=$1 FOR UPDATE OF upload`,
        [uploadId],
      );
      const upload = result.rows[0];
      if (upload !== undefined) {
        await client.query(
          `UPDATE trainer_video_uploads SET status='failed', last_error_code=$2,
             completed_at=$3, s3_multipart_upload_id=COALESCE(s3_multipart_upload_id,$4)
           WHERE id=$1 AND status='creating'`,
          [uploadId, errorCode.slice(0, 64), now, multipartUploadId],
        );
        if (multipartUploadId !== null) {
          await this.enqueueDeletion(
            client,
            upload.object_key,
            upload.s3_version_id,
            'failed_upload',
            upload.id,
            multipartUploadId,
            now,
            now,
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async getUploadForTrainer(
    uploadId: string,
    trainerUserId: string,
  ): Promise<VideoUploadSnapshot | null> {
    const result = await this.pool.query<UploadRow>(
      `${UPLOAD_SELECT}
       JOIN trainer_profiles authority ON authority.user_id = $2
       WHERE upload.id = $1 AND upload.uploader_user_id = $2
         AND authority.is_active = true AND authority.can_manage_videos = true`,
      [uploadId, trainerUserId],
    );
    return result.rows[0] === undefined ? null : mapUpload(result.rows[0]);
  }

  public async claimPartSignBatch(
    uploadId: string,
    trainerUserId: string,
    now: Date,
  ): Promise<'allowed' | 'forbidden' | 'state_conflict' | 'rate_limited'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await lockVideoTrainerAuthority(client, trainerUserId);
      if (authority === null) {
        await client.query('COMMIT');
        return 'forbidden';
      }
      const upload = await client.query(
        `SELECT id FROM trainer_video_uploads
         WHERE id=$1 AND uploader_user_id=$2 AND status='uploading' AND expires_at>$3
         FOR UPDATE`,
        [uploadId, trainerUserId, now],
      );
      if (upload.rowCount !== 1) {
        await client.query('COMMIT');
        return 'state_conflict';
      }
      await pruneVideoUploadRateEvents(client, trainerUserId, now);
      const recent = await client.query<{ readonly count: string }>(
        `SELECT COUNT(*) AS count FROM video_upload_rate_events
         WHERE trainer_user_id=$1 AND event_type='sign'
           AND occurred_at >= $2::timestamptz - INTERVAL '1 minute'`,
        [trainerUserId, now],
      );
      if (Number(recent.rows[0]?.count ?? 0) >= 30) {
        await client.query('COMMIT');
        return 'rate_limited';
      }
      await client.query(
        `INSERT INTO video_upload_rate_events (trainer_user_id,event_type,reserved_bytes,occurred_at)
         VALUES ($1,'sign',0,$2)`,
        [trainerUserId, now],
      );
      await client.query('COMMIT');
      return 'allowed';
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async savePartManifest(
    input: Parameters<VideoAdminRepository['savePartManifest']>[0],
  ): Promise<'created' | 'replayed' | 'conflict'> {
    const result = await this.pool.query<{
      readonly checksum_sha256_base64: string;
      readonly expected_size_bytes: number;
      readonly inserted: boolean;
    }>(
      `INSERT INTO trainer_video_upload_parts (
         upload_id, part_number, expected_size_bytes, checksum_sha256_base64, last_url_expires_at
       ) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (upload_id, part_number) DO UPDATE
         SET last_url_expires_at = EXCLUDED.last_url_expires_at,
             updated_at = NOW()
         WHERE trainer_video_upload_parts.expected_size_bytes = EXCLUDED.expected_size_bytes
           AND trainer_video_upload_parts.checksum_sha256_base64 = EXCLUDED.checksum_sha256_base64
       RETURNING checksum_sha256_base64, expected_size_bytes, (xmax = 0) AS inserted`,
      [
        input.uploadId,
        input.partNumber,
        input.expectedSizeBytes,
        input.checksumSha256Base64,
        input.expiresAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) return 'conflict';
    return row.inserted ? 'created' : 'replayed';
  }

  public async listPartManifests(uploadId: string): Promise<readonly VideoPartManifest[]> {
    const result = await this.pool.query<{
      readonly part_number: number;
      readonly expected_size_bytes: number;
      readonly checksum_sha256_base64: string;
    }>(
      `SELECT part_number, expected_size_bytes, checksum_sha256_base64
       FROM trainer_video_upload_parts WHERE upload_id=$1 ORDER BY part_number`,
      [uploadId],
    );
    return result.rows.map((row) => ({
      partNumber: row.part_number,
      expectedSizeBytes: row.expected_size_bytes,
      checksumSha256Base64: row.checksum_sha256_base64,
    }));
  }

  public async beginCompletion(
    uploadId: string,
    trainerUserId: string,
    now: Date,
    leaseSeconds: number,
  ): Promise<CompletionClaimResult> {
    const result = await this.pool.query<UploadRow>({
      text: `WITH changed AS (
         UPDATE trainer_video_uploads upload SET status='completing', lease_token=gen_random_uuid(),
           lease_expires_at=GREATEST($3, clock_timestamp()) + ($4 * INTERVAL '1 second')
         FROM trainer_profiles authority
         WHERE upload.id=$1 AND upload.uploader_user_id=$2
           AND authority.user_id=$2 AND authority.is_active=true AND authority.can_manage_videos=true
           AND (upload.status='uploading' OR
                (upload.status='completing' AND upload.lease_expires_at <= GREATEST($3, clock_timestamp())))
           AND upload.expires_at>GREATEST($3, clock_timestamp())
         RETURNING upload.*
       ) ${UPLOAD_SELECT.replace('FROM trainer_video_uploads AS upload', 'FROM changed AS upload')}`,
      values: [uploadId, trainerUserId, now, leaseSeconds],
    });
    const claimed = result.rows[0];
    if (claimed !== undefined && claimed.lease_token !== undefined)
      return {
        kind: 'claimed',
        upload: { ...mapUpload(claimed), leaseToken: claimed.lease_token },
      };
    const current = await this.pool.query<UploadRow>(
      `${UPLOAD_SELECT}
       JOIN trainer_profiles authority ON authority.user_id=$2
       WHERE upload.id=$1 AND upload.uploader_user_id=$2
         AND authority.is_active=true AND authority.can_manage_videos=true`,
      [uploadId, trainerUserId],
    );
    const row = current.rows[0];
    return row !== undefined &&
      ['completing', 'verification_pending', 'verifying', 'published'].includes(row.status)
      ? { kind: 'in_progress', upload: mapUpload(row) }
      : { kind: 'state_conflict' };
  }

  public async renewCompletionLease(
    uploadId: string,
    leaseToken: string,
    now: Date,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await this.pool.query({
      text: `UPDATE trainer_video_uploads
       SET lease_expires_at=GREATEST($3, clock_timestamp()) + ($4 * INTERVAL '1 second')
       WHERE id=$1 AND status='completing' AND lease_token=$2
         AND lease_expires_at>GREATEST($3, clock_timestamp())`,
      values: [uploadId, leaseToken, now, leaseSeconds],
    });
    return result.rowCount === 1;
  }

  public async markVerificationPending(
    input: Parameters<VideoAdminRepository['markVerificationPending']>[0],
  ): Promise<VideoUploadSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<UploadRow>({
        text: `WITH changed AS (
           UPDATE trainer_video_uploads SET status='verification_pending', actual_size_bytes=$2,
             s3_etag=$3, s3_version_id=$4, completed_at=$5,
             verification_next_attempt_at=$5, lease_token=NULL, lease_expires_at=NULL
           WHERE id=$1 AND status='completing' AND lease_token=$6
             AND lease_expires_at>GREATEST($5, clock_timestamp()) RETURNING *
         ) ${UPLOAD_SELECT.replace('FROM trainer_video_uploads AS upload', 'FROM changed AS upload')}`,
        values: [
          input.uploadId,
          input.sizeBytes,
          input.etag,
          input.versionId,
          input.now,
          input.leaseToken,
        ],
      });
      const changed = result.rows[0];
      if (changed !== undefined) {
        await client.query('COMMIT');
        return mapUpload(changed);
      }

      const expired = await client.query<UploadRow>(
        `${UPLOAD_SELECT} WHERE upload.id=$1 AND upload.status='expired' FOR UPDATE OF upload`,
        [input.uploadId],
      );
      const expiredRow = expired.rows[0];
      if (expiredRow !== undefined) {
        await client.query(
          `UPDATE trainer_video_uploads
           SET actual_size_bytes=$2, s3_etag=$3, s3_version_id=$4,
               completed_at=COALESCE(completed_at,$5)
           WHERE id=$1 AND status='expired'`,
          [input.uploadId, input.sizeBytes, input.etag, input.versionId, input.now],
        );
        await this.enqueueDeletion(
          client,
          expiredRow.object_key,
          input.versionId,
          'expired_upload',
          input.uploadId,
          null,
          input.now,
          input.now,
        );
      }
      await client.query('COMMIT');
      return null;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async releaseCompletion(
    uploadId: string,
    leaseToken: string,
    now: Date,
  ): Promise<VideoUploadSnapshot | null> {
    const result = await this.pool.query<UploadRow>({
      text: `WITH changed AS (
         UPDATE trainer_video_uploads
         SET status='uploading', lease_token=NULL, lease_expires_at=NULL
         WHERE id=$1 AND status='completing' AND lease_token=$2
           AND lease_expires_at>GREATEST($3, clock_timestamp())
         RETURNING *
       ) ${UPLOAD_SELECT.replace('FROM trainer_video_uploads AS upload', 'FROM changed AS upload')}`,
      values: [uploadId, leaseToken, now],
    });
    return result.rows[0] === undefined ? null : mapUpload(result.rows[0]);
  }

  public async cancelUpload(
    uploadId: string,
    trainerUserId: string,
    notBefore: Date,
    now: Date,
  ): Promise<VideoUploadSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await lockVideoTrainerAuthority(client, trainerUserId);
      if (authority === null) {
        await client.query('COMMIT');
        return null;
      }
      const result = await client.query<UploadRow>(
        `${UPLOAD_SELECT}
         WHERE upload.id=$1 AND upload.uploader_user_id=$2 FOR UPDATE OF upload`,
        [uploadId, trainerUserId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        await client.query('COMMIT');
        return null;
      }
      if (isLive(row.status) || row.status === 'verification_quarantined') {
        await client.query(
          `UPDATE trainer_video_uploads SET status='cancelled', cancelled_at=$3,
             completed_at=COALESCE(completed_at,$3), lease_token=NULL, lease_expires_at=NULL
           WHERE id=$1 AND uploader_user_id=$2`,
          [uploadId, trainerUserId, now],
        );
        await this.enqueueDeletion(
          client,
          row.object_key,
          row.s3_version_id,
          'cancelled_upload',
          uploadId,
          row.s3_multipart_upload_id,
          notBefore,
          now,
        );
      }
      await client.query('COMMIT');
      const refreshed = await this.pool.query<UploadRow>(`${UPLOAD_SELECT} WHERE upload.id=$1`, [
        uploadId,
      ]);
      return refreshed.rows[0] === undefined ? null : mapUpload(refreshed.rows[0]);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async unpublish(
    weekNumber: number,
    dayOfWeek: number,
    trainerUserId: string,
    now: Date,
  ): Promise<TrainerVideoSlotDto> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await lockVideoTrainerAuthority(client, trainerUserId);
      if (authority === null) throw new Error('Video trainer authority was revoked.');
      const result = await client.query(
        `UPDATE videos SET media_available=false,
           media_revision=media_revision + CASE WHEN media_available THEN 1 ELSE 0 END,
           updated_at=$3
         WHERE type='workout' AND week_number=$1 AND day_of_week=$2 RETURNING id`,
        [weekNumber, dayOfWeek, now],
      );
      if (result.rowCount !== 1) throw new Error('Workout slot not found.');
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
    const program = await this.listProgram();
    const slot = program.weeks
      .find((week) => week.week_number === weekNumber)
      ?.days.find((day) => day.day_of_week === dayOfWeek);
    if (slot === undefined) throw new Error('Workout slot not found.');
    return slot;
  }

  public async getPreviewObject(
    videoId: string,
    trainerUserId: string,
  ): Promise<{ objectKey: string; versionId: string | null; etag: string | null } | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await lockVideoTrainerAuthority(client, trainerUserId);
      if (authority === null) {
        await client.query('COMMIT');
        return null;
      }
      const result = await client.query<{
        readonly storage_key: string;
        readonly s3_version_id: string | null;
        readonly s3_etag: string | null;
      }>(
        `SELECT video.storage_key, published.s3_version_id, published.s3_etag FROM videos video
         LEFT JOIN LATERAL (
           SELECT upload.s3_version_id, upload.s3_etag FROM trainer_video_uploads upload
           WHERE upload.target_video_id=video.id AND upload.status='published'
             AND upload.object_key=video.storage_key
           ORDER BY upload.published_at DESC NULLS LAST, upload.id DESC LIMIT 1
         ) published ON true
         WHERE video.id=$1 AND video.type='workout' AND (
           video.media_available=true OR EXISTS (
             SELECT 1 FROM trainer_video_uploads upload
             WHERE upload.target_video_id=video.id AND upload.status='published'
               AND upload.object_key=video.storage_key
           )
         )`,
        [videoId],
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      return row === undefined
        ? null
        : { objectKey: row.storage_key, versionId: row.s3_version_id, etag: row.s3_etag };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimVerification(
    now: Date,
    leaseSeconds: number,
  ): Promise<ClaimedVideoUpload | null> {
    const result = await this.pool.query<UploadRow>({
      text: `WITH candidate AS (
         SELECT id FROM trainer_video_uploads
         WHERE (
             status='verification_pending'
             AND verification_next_attempt_at <= GREATEST($1, clock_timestamp())
           ) OR (
             status='verifying'
             AND lease_expires_at <= GREATEST($1, clock_timestamp())
           )
         ORDER BY completed_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
       ), changed AS (
         UPDATE trainer_video_uploads upload SET status='verifying', lease_token=gen_random_uuid(),
           lease_expires_at=GREATEST($1, clock_timestamp()) + ($2 * INTERVAL '1 second'),
           verification_attempt_count=verification_attempt_count+1
         FROM candidate WHERE upload.id=candidate.id RETURNING upload.*
       ) ${UPLOAD_SELECT.replace('FROM trainer_video_uploads AS upload', 'FROM changed AS upload')}`,
      values: [now, leaseSeconds],
    });
    const row = result.rows[0];
    if (row === undefined || row.lease_token === undefined) return null;
    return { ...mapUpload(row), leaseToken: row.lease_token };
  }

  public async renewVerificationLease(
    uploadId: string,
    leaseToken: string,
    now: Date,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await this.pool.query({
      text: `UPDATE trainer_video_uploads
       SET lease_expires_at=GREATEST($3, clock_timestamp()) + ($4 * INTERVAL '1 second')
       WHERE id=$1 AND status='verifying' AND lease_token=$2
         AND lease_expires_at>GREATEST($3, clock_timestamp())`,
      values: [uploadId, leaseToken, now, leaseSeconds],
    });
    return result.rowCount === 1;
  }

  public async publishVerified(
    input: Parameters<VideoAdminRepository['publishVerified']>[0],
  ): Promise<'published' | 'cancelled' | 'superseded'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${LEASE_QUERY_TIMEOUT_MS}ms'`);
      const result = await client.query<UploadRow>(
        `${UPLOAD_SELECT}
         WHERE upload.id=$1 AND upload.status='verifying' AND upload.lease_token=$2
           AND upload.lease_expires_at>clock_timestamp()
         FOR UPDATE OF upload`,
        [input.uploadId, input.leaseToken],
      );
      const upload = result.rows[0];
      if (upload === undefined) {
        await client.query('COMMIT');
        return 'cancelled';
      }
      const video = await client.query<{
        readonly storage_key: string;
        readonly media_available: boolean;
        readonly media_revision: string | number;
      }>(`SELECT storage_key, media_available, media_revision FROM videos WHERE id=$1 FOR UPDATE`, [
        upload.target_video_id,
      ]);
      const target = video.rows[0]!;
      const authority =
        upload.uploader_user_id === null
          ? { rowCount: 0 }
          : await client.query(
              `SELECT 1 FROM trainer_profiles WHERE user_id=$1 AND is_active=true AND can_manage_videos=true`,
              [upload.uploader_user_id],
            );
      if (authority.rowCount !== 1) {
        const cancelled = await client.query(
          `UPDATE trainer_video_uploads
           SET status='cancelled', cancelled_at=$3, completed_at=COALESCE(completed_at,$3),
             lease_token=NULL, lease_expires_at=NULL
           WHERE id=$1 AND status='verifying' AND lease_token=$2
             AND lease_expires_at>clock_timestamp()`,
          [input.uploadId, input.leaseToken, input.now],
        );
        if (cancelled.rowCount === 1) {
          await this.enqueueDeletion(
            client,
            upload.object_key,
            upload.s3_version_id,
            'cancelled_upload',
            upload.id,
            null,
            input.now,
            input.now,
          );
        }
        await client.query('COMMIT');
        return 'cancelled';
      }
      if (asNumber(target.media_revision) !== asNumber(upload.target_media_revision)) {
        const superseded = await client.query(
          `UPDATE trainer_video_uploads
           SET status='superseded', completed_at=COALESCE(completed_at,$3),
             lease_token=NULL, lease_expires_at=NULL
           WHERE id=$1 AND status='verifying' AND lease_token=$2
             AND lease_expires_at>clock_timestamp()`,
          [input.uploadId, input.leaseToken, input.now],
        );
        if (superseded.rowCount === 1) {
          await this.enqueueDeletion(
            client,
            upload.object_key,
            upload.s3_version_id,
            'superseded_upload',
            upload.id,
            null,
            input.now,
            input.now,
          );
        }
        await client.query('COMMIT');
        return 'superseded';
      }
      const previousReal = await client.query<{ readonly s3_version_id: string | null }>(
        `SELECT s3_version_id FROM trainer_video_uploads
         WHERE target_video_id=$1 AND status='published' AND object_key=$2
         ORDER BY published_at DESC NULLS LAST, id DESC LIMIT 1`,
        [upload.target_video_id, target.storage_key],
      );
      const published = await client.query(
        `UPDATE trainer_video_uploads SET status='published', actual_size_bytes=$2, sha256=$3,
           duration_seconds=$4, width=$5, height=$6, video_codec=$7, audio_codec=$8,
           verified_at=$9, published_at=$9, lease_token=NULL, lease_expires_at=NULL, last_error_code=NULL
         WHERE id=$1 AND status='verifying' AND lease_token=$10
           AND lease_expires_at>clock_timestamp()`,
        [
          input.uploadId,
          input.metadata.actualSizeBytes,
          input.metadata.sha256,
          input.metadata.durationSeconds,
          input.metadata.width,
          input.metadata.height,
          input.metadata.videoCodec,
          input.metadata.audioCodec,
          input.now,
          input.leaseToken,
        ],
      );
      if (published.rowCount !== 1) {
        await client.query('COMMIT');
        return 'cancelled';
      }
      await client.query(
        `UPDATE videos SET storage_key=$2, poster_key=NULL, duration_seconds=$3,
           media_available=true, status='published', media_revision=media_revision+1, updated_at=$4
         WHERE id=$1`,
        [upload.target_video_id, upload.object_key, input.metadata.durationSeconds, input.now],
      );
      const previousVersionId = previousReal.rows[0]?.s3_version_id ?? null;
      if (target.storage_key !== upload.object_key) {
        const grace = new Date(input.now.getTime() + input.graceSeconds * 1000);
        await this.enqueueDeletion(
          client,
          target.storage_key,
          previousVersionId,
          'replaced_media',
          upload.id,
          null,
          grace,
          input.now,
        );
      }
      await client.query('COMMIT');
      return 'published';
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async failVerification(
    uploadId: string,
    leaseToken: string,
    errorCode: string,
    now: Date,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${LEASE_QUERY_TIMEOUT_MS}ms'`);
      const result = await client.query<UploadRow>(
        `${UPLOAD_SELECT}
         WHERE upload.id=$1 AND upload.status='verifying' AND upload.lease_token=$2
           AND upload.lease_expires_at>clock_timestamp()
         FOR UPDATE OF upload`,
        [uploadId, leaseToken],
      );
      const row = result.rows[0];
      if (row !== undefined) {
        const failed = await client.query(
          `UPDATE trainer_video_uploads
           SET status='failed', last_error_code=$3, completed_at=COALESCE(completed_at,$4),
             lease_token=NULL, lease_expires_at=NULL
           WHERE id=$1 AND status='verifying' AND lease_token=$2
             AND lease_expires_at>clock_timestamp()`,
          [uploadId, leaseToken, errorCode.slice(0, 64), now],
        );
        if (failed.rowCount === 1) {
          await this.enqueueDeletion(
            client,
            row.object_key,
            row.s3_version_id,
            'failed_upload',
            row.id,
            null,
            now,
            now,
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async retryVerification(
    uploadId: string,
    leaseToken: string,
    errorCode: string,
    nextAttemptAt: Date,
    now: Date,
  ): Promise<boolean> {
    const result = await this.pool.query({
      text: `UPDATE trainer_video_uploads
       SET status='verification_pending', last_error_code=$3,
           verification_next_attempt_at=$4, lease_token=NULL, lease_expires_at=NULL
       WHERE id=$1 AND status='verifying' AND lease_token=$2
         AND lease_expires_at>GREATEST($5, clock_timestamp())`,
      values: [uploadId, leaseToken, errorCode.slice(0, 64), nextAttemptAt, now],
    });
    return result.rowCount === 1;
  }

  public async quarantineVerification(
    uploadId: string,
    leaseToken: string,
    errorCode: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.pool.query({
      text: `UPDATE trainer_video_uploads
       SET status='verification_quarantined', last_error_code=$3, quarantined_at=$4,
           completed_at=COALESCE(completed_at,$4), lease_token=NULL, lease_expires_at=NULL
       WHERE id=$1 AND status='verifying' AND lease_token=$2
         AND lease_expires_at>GREATEST($4, clock_timestamp())`,
      values: [uploadId, leaseToken, errorCode.slice(0, 64), now],
    });
    return result.rowCount === 1;
  }

  public async requeueQuarantinedVerification(
    uploadId: string,
    now: Date,
  ): Promise<'requeued' | 'slot_busy' | 'not_found'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidate = await client.query<{ readonly target_video_id: string }>(
        `SELECT target_video_id FROM trainer_video_uploads
         WHERE id=$1 AND status='verification_quarantined'`,
        [uploadId],
      );
      const targetVideoId = candidate.rows[0]?.target_video_id;
      if (targetVideoId === undefined) {
        await client.query('COMMIT');
        return 'not_found';
      }
      await client.query(`SELECT id FROM videos WHERE id=$1 FOR UPDATE`, [targetVideoId]);
      const changed = await client.query(
        `UPDATE trainer_video_uploads upload
         SET status='verification_pending', verification_attempt_count=0,
             verification_next_attempt_at=$2, last_error_code=NULL, quarantined_at=NULL
         WHERE upload.id=$1 AND upload.status='verification_quarantined'
           AND NOT EXISTS (
             SELECT 1 FROM trainer_video_uploads live
             WHERE live.target_video_id=upload.target_video_id AND live.id<>upload.id
               AND live.status IN (
                 'creating','uploading','completing','verification_pending','verifying'
               )
           )`,
        [uploadId, now],
      );
      if (changed.rowCount === 1) {
        await client.query('COMMIT');
        return 'requeued';
      }
      const stillQuarantined = await client.query(
        `SELECT 1 FROM trainer_video_uploads
         WHERE id=$1 AND status='verification_quarantined'`,
        [uploadId],
      );
      await client.query('COMMIT');
      return stillQuarantined.rowCount === 1 ? 'slot_busy' : 'not_found';
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async finalizeVerificationRun(now: Date, encounteredFailure: boolean): Promise<boolean> {
    const result = await this.pool.query<{ readonly healthy: boolean }>(
      `WITH health AS (
         SELECT NOT $2::boolean AND NOT EXISTS (
           SELECT 1 FROM trainer_video_uploads
           WHERE status='verifying'
              OR (
                status='verification_pending'
                AND last_error_code='verification_transient_failure'
              )
         ) AS healthy
       ), heartbeat AS (
         INSERT INTO video_worker_heartbeats (
           worker_name, last_succeeded_at, last_failed_at, last_error_code, updated_at
         )
         SELECT 'upload_verifier',
           CASE WHEN healthy THEN $1::timestamptz ELSE NULL END,
           CASE WHEN healthy THEN NULL ELSE $1::timestamptz END,
           CASE WHEN healthy THEN NULL ELSE 'verification_transient_failure' END,
           $1::timestamptz
         FROM health
         ON CONFLICT (worker_name) DO UPDATE SET
           last_succeeded_at=COALESCE(
             EXCLUDED.last_succeeded_at,
             video_worker_heartbeats.last_succeeded_at
           ),
           last_failed_at=COALESCE(
             EXCLUDED.last_failed_at,
             video_worker_heartbeats.last_failed_at
           ),
           last_error_code=EXCLUDED.last_error_code,
           updated_at=EXCLUDED.updated_at
         RETURNING worker_name
       )
       SELECT healthy FROM health, heartbeat`,
      [now, encounteredFailure],
    );
    return result.rows[0]?.healthy === true;
  }

  public async expireUploads(now: Date, completionAmbiguityGraceSeconds: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        readonly id: string;
        readonly object_key: string;
        readonly s3_version_id: string | null;
        readonly s3_multipart_upload_id: string | null;
        readonly cleanup_not_before: Date | string;
      }>(
        `SELECT upload.id, upload.object_key, upload.s3_version_id,
                upload.s3_multipart_upload_id,
                GREATEST(
                  $1::timestamptz,
                  COALESCE(parts.last_url_expires_at + INTERVAL '60 seconds', $1),
                  CASE WHEN upload.status='completing'
                    THEN GREATEST($1::timestamptz, upload.lease_expires_at)
                       + ($2 * INTERVAL '1 second')
                    ELSE $1::timestamptz
                  END
                ) AS cleanup_not_before
         FROM trainer_video_uploads upload
         LEFT JOIN LATERAL (
           SELECT MAX(part.last_url_expires_at) AS last_url_expires_at
           FROM trainer_video_upload_parts part WHERE part.upload_id=upload.id
         ) parts ON true
         WHERE upload.status IN ('creating','uploading','completing')
           AND upload.expires_at <= $1
           AND (
             upload.status <> 'completing'
             OR upload.lease_expires_at IS NULL
             OR upload.lease_expires_at <= GREATEST($1, clock_timestamp())
           )
         FOR UPDATE OF upload SKIP LOCKED`,
        [now, completionAmbiguityGraceSeconds],
      );
      for (const row of result.rows) {
        await client.query(
          `UPDATE trainer_video_uploads SET status='expired', completed_at=$2, lease_token=NULL, lease_expires_at=NULL WHERE id=$1`,
          [row.id, now],
        );
        await this.enqueueDeletion(
          client,
          row.object_key,
          row.s3_version_id,
          'expired_upload',
          row.id,
          row.s3_multipart_upload_id,
          asDate(row.cleanup_not_before),
          now,
        );
      }
      await client.query('COMMIT');
      return result.rows.length;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimDeletionJobs(now: Date, limit: number): Promise<readonly VideoDeletionJob[]> {
    const result = await this.pool.query<{
      readonly id: string;
      readonly object_key: string;
      readonly s3_version_id: string | null;
      readonly abort_multipart_upload_id: string | null;
      readonly attempt_count: number;
    }>(
      `WITH candidates AS (
         SELECT id FROM video_media_deletion_jobs WHERE completed_at IS NULL
           AND not_before <= $1 AND next_attempt_at <= $1
           AND (locked_at IS NULL OR locked_at <= $1::timestamptz - INTERVAL '15 minutes')
         ORDER BY next_attempt_at, requested_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
       ) UPDATE video_media_deletion_jobs job SET locked_at=$1, attempt_count=attempt_count+1
         FROM candidates WHERE job.id=candidates.id
         RETURNING job.id, job.object_key, job.s3_version_id, job.abort_multipart_upload_id, job.attempt_count`,
      [now, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      objectKey: row.object_key,
      versionId: row.s3_version_id,
      multipartUploadId: row.abort_multipart_upload_id,
      attemptCount: row.attempt_count,
    }));
  }

  public async isObjectReferenced(objectKey: string): Promise<boolean> {
    const result = await this.pool.query<{ readonly referenced: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM videos WHERE storage_key=$1) AS referenced`,
      [objectKey],
    );
    return result.rows[0]?.referenced === true;
  }

  public async completeDeletion(jobId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE video_media_deletion_jobs SET completed_at=$2, locked_at=NULL, last_error_code=NULL WHERE id=$1`,
      [jobId, now],
    );
  }

  public async retryDeletion(jobId: string, errorCode: string, nextAttemptAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE video_media_deletion_jobs SET next_attempt_at=$2, last_error_code=$3, locked_at=NULL WHERE id=$1 AND completed_at IS NULL`,
      [jobId, nextAttemptAt, errorCode.slice(0, 64)],
    );
  }

  public async finalizeCleanupRun(now: Date, encounteredFailure: boolean): Promise<boolean> {
    const result = await this.pool.query<{ readonly healthy: boolean }>(
      `WITH stale_rate_events AS (
         SELECT id FROM video_upload_rate_events
         WHERE occurred_at < $1::timestamptz - INTERVAL '2 days'
         ORDER BY occurred_at, id
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       ), pruned_rate_events AS (
         DELETE FROM video_upload_rate_events AS event
         USING stale_rate_events AS stale
         WHERE event.id=stale.id
         RETURNING event.id
       ), health AS (
         SELECT NOT $2::boolean AND NOT EXISTS (
           SELECT 1 FROM video_media_deletion_jobs
           WHERE completed_at IS NULL
             AND (
               locked_at IS NOT NULL
               OR COALESCE(last_error_code, '') NOT IN ('', 'object_still_referenced')
             )
         ) AS healthy
       ), heartbeat AS (
         INSERT INTO video_worker_heartbeats (
           worker_name, last_succeeded_at, last_failed_at, last_error_code, updated_at
         )
         SELECT 'media_cleanup',
           CASE WHEN healthy THEN $1::timestamptz ELSE NULL END,
           CASE WHEN healthy THEN NULL ELSE $1::timestamptz END,
           CASE WHEN healthy THEN NULL ELSE 'object_cleanup_failed' END,
           $1::timestamptz
         FROM health
         ON CONFLICT (worker_name) DO UPDATE SET
           last_succeeded_at=COALESCE(
             EXCLUDED.last_succeeded_at,
             video_worker_heartbeats.last_succeeded_at
           ),
           last_failed_at=COALESCE(
             EXCLUDED.last_failed_at,
             video_worker_heartbeats.last_failed_at
           ),
           last_error_code=EXCLUDED.last_error_code,
           updated_at=EXCLUDED.updated_at
         RETURNING worker_name
       )
       SELECT healthy
       FROM health, heartbeat, (SELECT COUNT(*) FROM pruned_rate_events) AS pruning`,
      [now, encounteredFailure, RATE_EVENT_PRUNE_LIMIT],
    );
    return result.rows[0]?.healthy === true;
  }

  public async updateHeartbeat(
    worker: 'upload_verifier' | 'media_cleanup',
    result: 'started' | 'succeeded' | 'failed',
    now: Date,
    errorCode?: string,
  ): Promise<void> {
    const column =
      result === 'started'
        ? 'last_started_at'
        : result === 'succeeded'
          ? 'last_succeeded_at'
          : 'last_failed_at';
    await this.pool.query(
      `INSERT INTO video_worker_heartbeats (worker_name, ${column}, last_error_code, updated_at)
       VALUES ($1,$2,$3,$2)
       ON CONFLICT (worker_name) DO UPDATE SET ${column}=EXCLUDED.${column},
         last_error_code=CASE
           WHEN $4='started' THEN video_worker_heartbeats.last_error_code
           ELSE EXCLUDED.last_error_code
         END,
         updated_at=EXCLUDED.updated_at`,
      [
        worker,
        now,
        result === 'failed' ? (errorCode ?? 'worker_failed').slice(0, 64) : null,
        result,
      ],
    );
  }

  private async enqueueDeletion(
    queryable: PoolClient,
    objectKey: string,
    versionId: string | null,
    reason:
      | 'failed_upload'
      | 'cancelled_upload'
      | 'expired_upload'
      | 'replaced_media'
      | 'superseded_upload',
    uploadId: string,
    multipartUploadId: string | null,
    notBefore: Date,
    now: Date,
  ): Promise<void> {
    await queryable.query(
      `INSERT INTO video_media_deletion_jobs (
         object_key, s3_version_id, reason, upload_id, abort_multipart_upload_id,
         requested_at, not_before, next_attempt_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (object_key, (COALESCE(s3_version_id, ''))) DO UPDATE SET
         abort_multipart_upload_id=COALESCE(
           video_media_deletion_jobs.abort_multipart_upload_id,
           EXCLUDED.abort_multipart_upload_id
         ),
         attempt_count=CASE
           WHEN video_media_deletion_jobs.completed_at IS NULL
             THEN video_media_deletion_jobs.attempt_count
           ELSE 0
         END,
         last_error_code=CASE
           WHEN video_media_deletion_jobs.completed_at IS NULL
             THEN video_media_deletion_jobs.last_error_code
           ELSE NULL
         END,
         locked_at=CASE
           WHEN video_media_deletion_jobs.completed_at IS NULL
             THEN video_media_deletion_jobs.locked_at
           ELSE NULL
         END,
         not_before=CASE
           WHEN video_media_deletion_jobs.completed_at IS NULL
             THEN GREATEST(video_media_deletion_jobs.not_before, EXCLUDED.not_before)
           ELSE EXCLUDED.not_before
         END,
         next_attempt_at=CASE
           WHEN video_media_deletion_jobs.completed_at IS NULL
             THEN GREATEST(video_media_deletion_jobs.next_attempt_at, EXCLUDED.next_attempt_at)
           ELSE EXCLUDED.next_attempt_at
         END,
         completed_at=NULL`,
      [objectKey, versionId, reason, uploadId, multipartUploadId, now, notBefore],
    );
  }
}
