ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_preferences jsonb;

UPDATE users
SET notification_preferences = jsonb_build_object(
  'workout_reminders', notification_enabled,
  'reminder_time', '09:00',
  'weekly_survey_reminder', true
)
WHERE notification_preferences IS NULL
   OR notification_preferences = '{}'::jsonb;

ALTER TABLE users
  ALTER COLUMN notification_preferences SET DEFAULT '{}'::jsonb,
  ALTER COLUMN notification_preferences SET NOT NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_notification_preferences_object;

ALTER TABLE users
  ADD CONSTRAINT users_notification_preferences_object CHECK (
    jsonb_typeof(notification_preferences) = 'object'
  ) NOT VALID;

ALTER TABLE users
  VALIDATE CONSTRAINT users_notification_preferences_object;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx
  ON refresh_tokens (user_id);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON password_reset_tokens (user_id);

CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx
  ON email_verification_tokens (user_id);
