CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  expiration_time timestamptz NULL,
  user_agent varchar(512) NULL,
  last_success_at timestamptz NULL,
  last_failure_at timestamptz NULL,
  disabled_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT push_subscriptions_endpoint_valid CHECK (
    char_length(endpoint) BETWEEN 1 AND 4096
    AND endpoint ~* '^https://'
  ),
  CONSTRAINT push_subscriptions_p256dh_valid CHECK (
    char_length(p256dh) BETWEEN 40 AND 256
    AND p256dh ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT push_subscriptions_auth_valid CHECK (
    char_length(auth) BETWEEN 8 AND 128
    AND auth ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT push_subscriptions_user_agent_valid CHECK (
    user_agent IS NULL OR char_length(user_agent) <= 512
  )
);

DROP TRIGGER IF EXISTS push_subscriptions_set_updated_at ON push_subscriptions;
CREATE TRIGGER push_subscriptions_set_updated_at
BEFORE UPDATE ON push_subscriptions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_unique_idx
  ON push_subscriptions (endpoint);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_active_idx
  ON push_subscriptions (user_id, id)
  WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS push_subscriptions_expiration_idx
  ON push_subscriptions (expiration_time)
  WHERE disabled_at IS NULL AND expiration_time IS NOT NULL;

CREATE TABLE IF NOT EXISTS push_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type varchar(32) NOT NULL,
  occurrence_key varchar(512) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'claimed',
  error_code varchar(64) NULL,
  claimed_at timestamptz NOT NULL DEFAULT NOW(),
  sent_at timestamptz NULL,
  failed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT push_notification_deliveries_type_valid CHECK (
    notification_type IN ('workout_reminder', 'weekly_survey_reminder')
  ),
  CONSTRAINT push_notification_deliveries_occurrence_not_blank CHECK (
    char_length(btrim(occurrence_key)) BETWEEN 1 AND 512
  ),
  CONSTRAINT push_notification_deliveries_status_valid CHECK (
    status IN ('claimed', 'sent', 'failed', 'invalidated')
  ),
  CONSTRAINT push_notification_deliveries_error_code_valid CHECK (
    error_code IS NULL OR char_length(error_code) BETWEEN 1 AND 64
  ),
  CONSTRAINT push_notification_deliveries_terminal_state_valid CHECK (
    (status = 'claimed' AND sent_at IS NULL AND failed_at IS NULL)
    OR (status = 'sent' AND sent_at IS NOT NULL AND failed_at IS NULL AND error_code IS NULL)
    OR (status IN ('failed', 'invalidated') AND sent_at IS NULL AND failed_at IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS push_notification_deliveries_set_updated_at
  ON push_notification_deliveries;
CREATE TRIGGER push_notification_deliveries_set_updated_at
BEFORE UPDATE ON push_notification_deliveries
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS push_notification_deliveries_occurrence_unique_idx
  ON push_notification_deliveries (
    subscription_id,
    user_id,
    notification_type,
    occurrence_key
  );

CREATE INDEX IF NOT EXISTS push_notification_deliveries_user_created_idx
  ON push_notification_deliveries (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS push_notification_deliveries_claimed_idx
  ON push_notification_deliveries (claimed_at, id)
  WHERE status = 'claimed';
