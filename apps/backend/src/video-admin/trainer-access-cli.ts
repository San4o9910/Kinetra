import { z } from 'zod';

import { closeDatabasePool, databasePool } from '../db/pool.js';

const uuid = z.string().uuid();
const help = (command: string | undefined): string =>
  command === 'grant'
    ? 'Usage: grant --user-id <UUID>'
    : command === 'revoke'
      ? 'Usage: revoke --user-id <UUID>'
      : 'Usage: <grant|revoke> --user-id <UUID>';

const userIdFrom = (arguments_: readonly string[]): string => {
  if (arguments_.length !== 2 || arguments_[0] !== '--user-id')
    throw new Error('Provide exactly --user-id <UUID>.');
  const parsed = uuid.safeParse(arguments_[1]);
  if (!parsed.success) throw new Error('--user-id must be a UUID.');
  return parsed.data;
};

const run = async (): Promise<void> => {
  const [command, ...arguments_] = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === '--help') {
    console.log(help(command));
    return;
  }
  if (command !== 'grant' && command !== 'revoke') throw new Error(help(command));
  const userId = userIdFrom(arguments_);
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    const profile = await client.query(
      `SELECT user_id FROM trainer_profiles WHERE user_id=$1 FOR UPDATE`,
      [userId],
    );
    if (profile.rowCount !== 1) throw new Error('Existing trainer profile was not found.');
    if (command === 'grant') {
      await client.query(
        `UPDATE trainer_profiles SET can_manage_videos=true, updated_at=NOW() WHERE user_id=$1`,
        [userId],
      );
    } else {
      await client.query(
        `UPDATE trainer_profiles SET can_manage_videos=false, updated_at=NOW() WHERE user_id=$1`,
        [userId],
      );
      const uploads = await client.query<{
        readonly id: string;
        readonly object_key: string;
        readonly s3_version_id: string | null;
        readonly s3_multipart_upload_id: string | null;
      }>(
        `UPDATE trainer_video_uploads SET status='cancelled', cancelled_at=NOW(),
           completed_at=COALESCE(completed_at,NOW()), lease_token=NULL, lease_expires_at=NULL
         WHERE uploader_user_id=$1
           AND status IN (
             'creating','uploading','completing','verification_pending','verifying',
             'verification_quarantined'
           )
         RETURNING id, object_key, s3_version_id, s3_multipart_upload_id`,
        [userId],
      );
      for (const upload of uploads.rows) {
        await client.query(
          `INSERT INTO video_media_deletion_jobs (
             object_key, s3_version_id, reason, upload_id, abort_multipart_upload_id,
             requested_at, not_before, next_attempt_at
           ) VALUES ($1,$2,'cancelled_upload',$3,$4,NOW(),
             GREATEST(NOW() + INTERVAL '60 seconds', COALESCE((
               SELECT MAX(last_url_expires_at) + INTERVAL '60 seconds'
               FROM trainer_video_upload_parts WHERE upload_id=$3
             ), NOW() + INTERVAL '60 seconds')),
             GREATEST(NOW() + INTERVAL '60 seconds', COALESCE((
               SELECT MAX(last_url_expires_at) + INTERVAL '60 seconds'
               FROM trainer_video_upload_parts WHERE upload_id=$3
             ), NOW() + INTERVAL '60 seconds')))
           ON CONFLICT (object_key, (COALESCE(s3_version_id, ''))) DO UPDATE SET
             abort_multipart_upload_id=COALESCE(
               video_media_deletion_jobs.abort_multipart_upload_id,
               EXCLUDED.abort_multipart_upload_id
             ),
             not_before=GREATEST(video_media_deletion_jobs.not_before, EXCLUDED.not_before),
             next_attempt_at=GREATEST(
               video_media_deletion_jobs.next_attempt_at,
               EXCLUDED.next_attempt_at
             )`,
          [upload.object_key, upload.s3_version_id, upload.id, upload.s3_multipart_upload_id],
        );
      }
    }
    await client.query('COMMIT');
    console.log('Kinetra video trainer permission audit.', {
      action: command,
      status: 'success',
      trainerUserId: userId,
    });
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw caught;
  } finally {
    client.release();
  }
};

void run()
  .catch((caught: unknown) => {
    console.error(
      caught instanceof Error ? caught.message : 'Video trainer permission command failed.',
    );
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
