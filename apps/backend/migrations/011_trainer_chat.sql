CREATE TABLE IF NOT EXISTS trainer_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name varchar(120) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT trainer_profiles_display_name_valid CHECK (
    display_name = btrim(display_name)
    AND char_length(display_name) BETWEEN 1 AND 120
  ),
  CONSTRAINT trainer_profiles_default_active CHECK (NOT is_default OR is_active)
);

DROP TRIGGER IF EXISTS trainer_profiles_set_updated_at ON trainer_profiles;
CREATE TRIGGER trainer_profiles_set_updated_at
BEFORE UPDATE ON trainer_profiles
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS trainer_profiles_one_active_default_idx
  ON trainer_profiles (is_default)
  WHERE is_active = true AND is_default = true;

CREATE INDEX IF NOT EXISTS trainer_profiles_active_idx
  ON trainer_profiles (user_id)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  trainer_user_id uuid NOT NULL REFERENCES trainer_profiles(user_id) ON DELETE RESTRICT,
  next_sequence bigint NOT NULL DEFAULT 1,
  last_message_sequence bigint NULL,
  last_message_at timestamptz NULL,
  client_last_read_sequence bigint NOT NULL DEFAULT 0,
  trainer_last_read_sequence bigint NOT NULL DEFAULT 0,
  client_unread_count integer NOT NULL DEFAULT 0,
  trainer_unread_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_conversations_participants_differ CHECK (client_user_id <> trainer_user_id),
  CONSTRAINT chat_conversations_next_sequence_valid CHECK (next_sequence >= 1),
  CONSTRAINT chat_conversations_last_sequence_valid CHECK (
    last_message_sequence IS NULL
    OR (last_message_sequence >= 1 AND last_message_sequence < next_sequence)
  ),
  CONSTRAINT chat_conversations_last_message_state_valid CHECK (
    (last_message_sequence IS NULL AND last_message_at IS NULL)
    OR (last_message_sequence IS NOT NULL AND last_message_at IS NOT NULL)
  ),
  CONSTRAINT chat_conversations_client_read_valid CHECK (
    client_last_read_sequence >= 0 AND client_last_read_sequence < next_sequence
  ),
  CONSTRAINT chat_conversations_trainer_read_valid CHECK (
    trainer_last_read_sequence >= 0 AND trainer_last_read_sequence < next_sequence
  ),
  CONSTRAINT chat_conversations_client_unread_valid CHECK (client_unread_count >= 0),
  CONSTRAINT chat_conversations_trainer_unread_valid CHECK (trainer_unread_count >= 0)
);

DROP TRIGGER IF EXISTS chat_conversations_set_updated_at ON chat_conversations;
CREATE TRIGGER chat_conversations_set_updated_at
BEFORE UPDATE ON chat_conversations
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS chat_conversations_trainer_inbox_idx
  ON chat_conversations (
    trainer_user_id,
    (COALESCE(last_message_at, created_at)) DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS chat_conversations_trainer_unread_idx
  ON chat_conversations (
    trainer_user_id,
    (COALESCE(last_message_at, created_at)) DESC,
    id DESC
  )
  WHERE trainer_unread_count > 0;

CREATE INDEX IF NOT EXISTS chat_conversations_client_lookup_idx
  ON chat_conversations (client_user_id, id);

CREATE TABLE IF NOT EXISTS chat_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  uploader_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_upload_id uuid NOT NULL,
  input_sha256 char(64) NOT NULL,
  object_key text NOT NULL UNIQUE,
  mime_type varchar(64) NOT NULL,
  size_bytes integer NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  status varchar(16) NOT NULL,
  expires_at timestamptz NOT NULL,
  processing_started_at timestamptz NULL,
  processing_lease_expires_at timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 1,
  last_error_code varchar(64) NULL,
  attached_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_photos_owner_upload_unique UNIQUE (uploader_user_id, client_upload_id),
  CONSTRAINT chat_photos_conversation_identity_unique UNIQUE (id, conversation_id),
  CONSTRAINT chat_photos_hash_valid CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chat_photos_object_key_valid CHECK (char_length(object_key) BETWEEN 1 AND 1024),
  CONSTRAINT chat_photos_mime_valid CHECK (mime_type = 'image/webp'),
  CONSTRAINT chat_photos_size_valid CHECK (size_bytes BETWEEN 1 AND 4194304),
  CONSTRAINT chat_photos_width_valid CHECK (width BETWEEN 1 AND 2048),
  CONSTRAINT chat_photos_height_valid CHECK (height BETWEEN 1 AND 2048),
  CONSTRAINT chat_photos_status_valid CHECK (status IN ('processing', 'ready', 'attached', 'failed')),
  CONSTRAINT chat_photos_attempt_count_valid CHECK (attempt_count BETWEEN 1 AND 3),
  CONSTRAINT chat_photos_error_code_valid CHECK (
    last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 64
  ),
  CONSTRAINT chat_photos_lifecycle_valid CHECK (
    (
      status = 'processing'
      AND attached_at IS NULL
      AND processing_started_at IS NOT NULL
      AND processing_lease_expires_at IS NOT NULL
      AND processing_lease_expires_at > processing_started_at
      AND expires_at > created_at
    )
    OR (
      status = 'ready'
      AND attached_at IS NULL
      AND processing_started_at IS NULL
      AND processing_lease_expires_at IS NULL
      AND expires_at > created_at
      AND last_error_code IS NULL
    )
    OR (
      status = 'failed'
      AND attached_at IS NULL
      AND processing_started_at IS NULL
      AND processing_lease_expires_at IS NULL
      AND last_error_code IS NOT NULL
    )
    OR (
      status = 'attached'
      AND attached_at IS NOT NULL
      AND processing_started_at IS NULL
      AND processing_lease_expires_at IS NULL
      AND last_error_code IS NULL
    )
  )
);

DROP TRIGGER IF EXISTS chat_photos_set_updated_at ON chat_photos;
CREATE TRIGGER chat_photos_set_updated_at
BEFORE UPDATE ON chat_photos
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS chat_photos_conversation_idx
  ON chat_photos (conversation_id, id);

CREATE INDEX IF NOT EXISTS chat_photos_cleanup_idx
  ON chat_photos (status, processing_lease_expires_at, expires_at, id)
  WHERE status IN ('processing', 'ready', 'failed');

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  sender_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_role varchar(16) NOT NULL,
  sender_name_snapshot varchar(120) NOT NULL,
  client_message_id uuid NOT NULL,
  request_fingerprint char(64) NOT NULL,
  kind varchar(16) NOT NULL,
  body text NULL,
  photo_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_messages_conversation_sequence_unique UNIQUE (conversation_id, sequence),
  CONSTRAINT chat_messages_sender_idempotency_unique UNIQUE (
    conversation_id,
    sender_user_id,
    client_message_id
  ),
  CONSTRAINT chat_messages_photo_conversation_fk FOREIGN KEY (photo_id, conversation_id)
    REFERENCES chat_photos(id, conversation_id),
  CONSTRAINT chat_messages_sequence_valid CHECK (sequence >= 1),
  CONSTRAINT chat_messages_sender_role_valid CHECK (sender_role IN ('client', 'trainer')),
  CONSTRAINT chat_messages_sender_name_valid CHECK (
    sender_name_snapshot = btrim(sender_name_snapshot)
    AND char_length(sender_name_snapshot) BETWEEN 1 AND 120
  ),
  CONSTRAINT chat_messages_fingerprint_valid CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chat_messages_kind_valid CHECK (kind IN ('text', 'photo')),
  CONSTRAINT chat_messages_body_controls_valid CHECK (
    body IS NULL OR body !~ U&'[\0001-\0008\000B-\001F\007F]'
  ),
  CONSTRAINT chat_messages_content_valid CHECK (
    (
      kind = 'text'
      AND photo_id IS NULL
      AND body IS NOT NULL
      AND char_length(body) BETWEEN 1 AND 2000
      AND btrim(body) <> ''
    )
    OR (
      kind = 'photo'
      AND photo_id IS NOT NULL
      AND (
        body IS NULL
        OR (
          char_length(body) BETWEEN 1 AND 1000
          AND btrim(body) <> ''
        )
      )
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_photo_unique_idx
  ON chat_messages (photo_id)
  WHERE photo_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_messages_conversation_sequence_desc_idx
  ON chat_messages (conversation_id, sequence DESC);

CREATE INDEX IF NOT EXISTS chat_messages_conversation_sender_sequence_idx
  ON chat_messages (conversation_id, sender_role, sequence);

CREATE INDEX IF NOT EXISTS chat_messages_idempotency_lookup_idx
  ON chat_messages (conversation_id, sender_user_id, client_message_id);

CREATE TABLE IF NOT EXISTS chat_media_deletion_jobs (
  object_key text PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT NOW(),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  last_error_code varchar(64) NULL,
  locked_at timestamptz NULL,
  completed_at timestamptz NULL,
  CONSTRAINT chat_media_deletion_jobs_key_valid CHECK (char_length(object_key) BETWEEN 1 AND 1024),
  CONSTRAINT chat_media_deletion_jobs_attempt_valid CHECK (attempt_count >= 0),
  CONSTRAINT chat_media_deletion_jobs_error_valid CHECK (
    last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 64
  ),
  CONSTRAINT chat_media_deletion_jobs_completion_valid CHECK (
    completed_at IS NULL OR locked_at IS NULL
  )
);

CREATE INDEX IF NOT EXISTS chat_media_deletion_jobs_pending_idx
  ON chat_media_deletion_jobs (next_attempt_at, requested_at, object_key)
  WHERE completed_at IS NULL;

CREATE OR REPLACE FUNCTION enqueue_chat_photo_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO chat_media_deletion_jobs (object_key, requested_at, next_attempt_at)
  VALUES (OLD.object_key, NOW(), NOW())
  ON CONFLICT (object_key) DO NOTHING;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS chat_photos_enqueue_deletion ON chat_photos;
CREATE TRIGGER chat_photos_enqueue_deletion
BEFORE DELETE ON chat_photos
FOR EACH ROW
EXECUTE FUNCTION enqueue_chat_photo_deletion();
