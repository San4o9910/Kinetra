CREATE TABLE IF NOT EXISTS chat_video_assets (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  uploader_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK(status IN ('uploading','ready')),
  duration_seconds integer CHECK(duration_seconds BETWEEN 1 AND 180),
  size_bytes integer CHECK(size_bytes BETWEEN 1 AND 33554432),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_video_assets_conversation ON chat_video_assets(conversation_id,created_at DESC);
DROP TRIGGER IF EXISTS chat_video_assets_enqueue_deletion ON chat_video_assets;
CREATE TRIGGER chat_video_assets_enqueue_deletion BEFORE DELETE ON chat_video_assets
  FOR EACH ROW EXECUTE FUNCTION enqueue_chat_photo_deletion();
