ALTER TABLE trainer_profiles
  ADD COLUMN IF NOT EXISTS can_manage_videos boolean NOT NULL DEFAULT false;

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS media_revision bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'videos_media_revision_valid'
  ) THEN
    ALTER TABLE videos
      ADD CONSTRAINT videos_media_revision_valid CHECK (media_revision >= 0);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS trainer_video_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_video_id uuid NOT NULL REFERENCES videos(id) ON DELETE RESTRICT,
  uploader_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  uploader_display_name_snapshot varchar(120) NULL,
  idempotency_key uuid NOT NULL,
  request_fingerprint char(64) NOT NULL,
  object_key text NOT NULL UNIQUE,
  s3_multipart_upload_id text NULL,
  declared_mime_type varchar(64) NOT NULL,
  expected_size_bytes bigint NOT NULL,
  part_size_bytes integer NOT NULL,
  expected_part_count integer NOT NULL,
  target_media_revision bigint NOT NULL,
  status varchar(32) NOT NULL,
  actual_size_bytes bigint NULL,
  sha256 char(64) NULL,
  s3_etag varchar(255) NULL,
  s3_version_id varchar(1024) NULL,
  duration_seconds integer NULL,
  width integer NULL,
  height integer NULL,
  video_codec varchar(32) NULL,
  audio_codec varchar(32) NULL,
  last_error_code varchar(64) NULL,
  expires_at timestamptz NOT NULL,
  lease_token uuid NULL,
  lease_expires_at timestamptz NULL,
  verification_attempt_count integer NOT NULL DEFAULT 0,
  verification_next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz NULL,
  verified_at timestamptz NULL,
  quarantined_at timestamptz NULL,
  published_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  CONSTRAINT trainer_video_uploads_uploader_idempotency_unique
    UNIQUE (uploader_user_id, idempotency_key),
  CONSTRAINT trainer_video_uploads_uploader_snapshot_valid CHECK (
    uploader_display_name_snapshot IS NULL OR (
      uploader_display_name_snapshot = btrim(uploader_display_name_snapshot)
      AND char_length(uploader_display_name_snapshot) BETWEEN 1 AND 120
    )
  ),
  CONSTRAINT trainer_video_uploads_fingerprint_valid CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT trainer_video_uploads_object_key_valid CHECK (
    object_key ~ '^videos/workouts/week-[0-9]{2}/day-[1-7]/[0-9a-f-]{36}\.mp4$'
  ),
  CONSTRAINT trainer_video_uploads_multipart_id_valid CHECK (
    s3_multipart_upload_id IS NULL OR char_length(s3_multipart_upload_id) BETWEEN 1 AND 2048
  ),
  CONSTRAINT trainer_video_uploads_mime_valid CHECK (declared_mime_type = 'video/mp4'),
  CONSTRAINT trainer_video_uploads_size_valid CHECK (
    expected_size_bytes BETWEEN 1 AND 2147483648
  ),
  CONSTRAINT trainer_video_uploads_part_size_valid CHECK (
    part_size_bytes BETWEEN 5242880 AND 67108864
  ),
  CONSTRAINT trainer_video_uploads_part_count_valid CHECK (
    expected_part_count BETWEEN 1 AND 10000
  ),
  CONSTRAINT trainer_video_uploads_revision_valid CHECK (target_media_revision >= 0),
  CONSTRAINT trainer_video_uploads_status_valid CHECK (
    status IN (
      'creating', 'uploading', 'completing', 'verification_pending', 'verifying',
      'verification_quarantined',
      'published', 'failed', 'cancelled', 'expired', 'superseded'
    )
  ),
  CONSTRAINT trainer_video_uploads_sha_valid CHECK (
    sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT trainer_video_uploads_dimensions_valid CHECK (
    (width IS NULL AND height IS NULL)
    OR (width BETWEEN 1 AND 3840 AND height BETWEEN 1 AND 2160)
  ),
  CONSTRAINT trainer_video_uploads_duration_valid CHECK (
    duration_seconds IS NULL OR duration_seconds BETWEEN 10 AND 10800
  ),
  CONSTRAINT trainer_video_uploads_attempt_valid CHECK (verification_attempt_count >= 0),
  CONSTRAINT trainer_video_uploads_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT trainer_video_uploads_lease_valid CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT trainer_video_uploads_terminal_time_valid CHECK (
    (status = 'published' AND published_at IS NOT NULL AND verified_at IS NOT NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
    OR (status = 'verification_quarantined' AND quarantined_at IS NOT NULL)
    OR (status NOT IN ('published', 'cancelled', 'verification_quarantined'))
  )
);

DROP TRIGGER IF EXISTS trainer_video_uploads_set_updated_at ON trainer_video_uploads;
CREATE TRIGGER trainer_video_uploads_set_updated_at
BEFORE UPDATE ON trainer_video_uploads
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS trainer_video_uploads_one_live_per_video_idx
  ON trainer_video_uploads (target_video_id)
  WHERE status IN ('creating', 'uploading', 'completing', 'verification_pending', 'verifying');

CREATE INDEX IF NOT EXISTS trainer_video_uploads_verification_lease_idx
  ON trainer_video_uploads (status, verification_next_attempt_at, lease_expires_at, completed_at, id)
  WHERE status IN ('verification_pending', 'verifying');

CREATE INDEX IF NOT EXISTS trainer_video_uploads_expiration_idx
  ON trainer_video_uploads (expires_at, id)
  WHERE status IN ('creating', 'uploading', 'completing');

CREATE INDEX IF NOT EXISTS trainer_video_uploads_uploader_history_idx
  ON trainer_video_uploads (uploader_user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS trainer_video_upload_parts (
  upload_id uuid NOT NULL REFERENCES trainer_video_uploads(id) ON DELETE CASCADE,
  part_number integer NOT NULL,
  expected_size_bytes integer NOT NULL,
  checksum_sha256_base64 char(44) NOT NULL,
  last_url_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (upload_id, part_number),
  CONSTRAINT trainer_video_upload_parts_number_valid CHECK (part_number BETWEEN 1 AND 10000),
  CONSTRAINT trainer_video_upload_parts_size_valid CHECK (expected_size_bytes > 0),
  CONSTRAINT trainer_video_upload_parts_checksum_valid CHECK (
    checksum_sha256_base64 ~ '^[A-Za-z0-9+/]{43}=$'
    AND encode(decode(checksum_sha256_base64, 'base64'), 'base64') = checksum_sha256_base64
  ),
  CONSTRAINT trainer_video_upload_parts_expiry_valid CHECK (
    last_url_expires_at > created_at
  )
);

DROP TRIGGER IF EXISTS trainer_video_upload_parts_set_updated_at ON trainer_video_upload_parts;
CREATE TRIGGER trainer_video_upload_parts_set_updated_at
BEFORE UPDATE ON trainer_video_upload_parts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS video_media_deletion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key text NOT NULL,
  s3_version_id varchar(1024) NULL,
  reason varchar(32) NOT NULL,
  upload_id uuid NULL REFERENCES trainer_video_uploads(id) ON DELETE SET NULL,
  abort_multipart_upload_id varchar(2048) NULL,
  requested_at timestamptz NOT NULL DEFAULT NOW(),
  not_before timestamptz NOT NULL DEFAULT NOW(),
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code varchar(64) NULL,
  locked_at timestamptz NULL,
  completed_at timestamptz NULL,
  CONSTRAINT video_media_deletion_jobs_key_valid CHECK (
    object_key ~ '^videos/workouts/' AND char_length(object_key) <= 1024
  ),
  CONSTRAINT video_media_deletion_jobs_reason_valid CHECK (
    reason IN (
      'failed_upload', 'cancelled_upload', 'expired_upload',
      'replaced_media', 'superseded_upload'
    )
  ),
  CONSTRAINT video_media_deletion_jobs_attempt_valid CHECK (attempt_count >= 0),
  CONSTRAINT video_media_deletion_jobs_schedule_valid CHECK (
    next_attempt_at >= requested_at AND not_before >= requested_at
  ),
  CONSTRAINT video_media_deletion_jobs_completion_valid CHECK (
    completed_at IS NULL OR locked_at IS NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS video_media_deletion_jobs_object_version_unique_idx
  ON video_media_deletion_jobs (object_key, COALESCE(s3_version_id, ''));

CREATE INDEX IF NOT EXISTS video_media_deletion_jobs_pending_idx
  ON video_media_deletion_jobs (next_attempt_at, not_before, requested_at, id)
  WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS video_worker_heartbeats (
  worker_name varchar(32) PRIMARY KEY,
  last_started_at timestamptz NULL,
  last_succeeded_at timestamptz NULL,
  last_failed_at timestamptz NULL,
  last_error_code varchar(64) NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT video_worker_heartbeats_name_valid CHECK (
    worker_name IN ('upload_verifier', 'media_cleanup')
  ),
  CONSTRAINT video_worker_heartbeats_error_valid CHECK (
    last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 64
  )
);

CREATE TABLE IF NOT EXISTS video_upload_rate_events (
  id bigserial PRIMARY KEY,
  trainer_user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type varchar(16) NOT NULL,
  reserved_bytes bigint NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT video_upload_rate_events_type_valid CHECK (event_type IN ('init', 'sign')),
  CONSTRAINT video_upload_rate_events_bytes_valid CHECK (reserved_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS video_upload_rate_events_window_idx
  ON video_upload_rate_events (trainer_user_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS video_upload_rate_events_retention_idx
  ON video_upload_rate_events (occurred_at, id);
