ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS media_available boolean NOT NULL DEFAULT false;

ALTER TABLE videos
  DROP CONSTRAINT IF EXISTS videos_media_available_requires_storage_key;

ALTER TABLE videos
  ADD CONSTRAINT videos_media_available_requires_storage_key CHECK (
    NOT media_available OR storage_key IS NOT NULL
  );
