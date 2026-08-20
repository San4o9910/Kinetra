ALTER TABLE videos
  DROP CONSTRAINT IF EXISTS videos_storage_key_not_blank;

ALTER TABLE videos
  ALTER COLUMN storage_key DROP NOT NULL;

ALTER TABLE videos
  ADD CONSTRAINT videos_storage_key_not_blank CHECK (
    storage_key IS NULL OR btrim(storage_key) <> ''
  );

ALTER TABLE videos
  ADD CONSTRAINT videos_workout_storage_key_required CHECK (
    type = 'base_lesson' OR storage_key IS NOT NULL
  );

WITH placeholders (slug, storage_key, poster_key) AS (
  VALUES
    (
      'base-lesson-01-breathing-check',
      'videos/base-lessons/01.mp4',
      'posters/base-lessons/01.jpg'
    ),
    (
      'base-lesson-02-push-ups',
      'videos/base-lessons/02.mp4',
      'posters/base-lessons/02.jpg'
    ),
    (
      'base-lesson-03-pull-ups',
      'videos/base-lessons/03.mp4',
      'posters/base-lessons/03.jpg'
    ),
    (
      'base-lesson-04-squats',
      'videos/base-lessons/04.mp4',
      'posters/base-lessons/04.jpg'
    ),
    (
      'base-lesson-05-deadlift',
      'videos/base-lessons/05.mp4',
      'posters/base-lessons/05.jpg'
    ),
    (
      'base-lesson-06-daily-training',
      'videos/base-lessons/06.mp4',
      'posters/base-lessons/06.jpg'
    ),
    (
      'base-lesson-07-nutrition',
      'videos/base-lessons/07.mp4',
      'posters/base-lessons/07.jpg'
    )
)
UPDATE videos AS video
SET storage_key = CASE
      WHEN video.storage_key = placeholder.storage_key THEN NULL
      ELSE video.storage_key
    END,
    poster_key = CASE
      WHEN video.poster_key = placeholder.poster_key THEN NULL
      ELSE video.poster_key
    END
FROM placeholders AS placeholder
WHERE video.slug = placeholder.slug
  AND video.type = 'base_lesson'
  AND (
    video.storage_key = placeholder.storage_key
    OR video.poster_key = placeholder.poster_key
  );

ALTER TABLE video_progress
  DROP CONSTRAINT IF EXISTS video_progress_completed_state_valid;

UPDATE video_progress
SET completed_at = COALESCE(completed_at, updated_at, NOW())
WHERE completion_percent >= 90
  AND completed_at IS NULL;

ALTER TABLE video_progress
  ADD CONSTRAINT video_progress_completed_state_valid CHECK (
    completed_at IS NULL OR completion_percent >= 90
  );

CREATE INDEX IF NOT EXISTS video_progress_user_completed_idx
  ON video_progress (user_id, video_id)
  WHERE completion_percent >= 90;
