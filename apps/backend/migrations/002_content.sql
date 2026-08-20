CREATE TABLE IF NOT EXISTS videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug varchar(160) NOT NULL,
  title varchar(255) NOT NULL,
  description text NULL,
  type varchar(32) NOT NULL,
  day_of_week smallint NULL,
  week_number smallint NULL,
  duration_seconds integer NOT NULL,
  storage_key text NOT NULL,
  poster_key text NULL,
  status varchar(32) NOT NULL DEFAULT 'draft',
  order_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT videos_slug_unique UNIQUE (slug),
  CONSTRAINT videos_slug_normalized CHECK (
    slug = lower(btrim(slug))
    AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  CONSTRAINT videos_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT videos_type_valid CHECK (type IN ('base_lesson', 'workout')),
  CONSTRAINT videos_day_of_week_valid CHECK (
    day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7
  ),
  CONSTRAINT videos_week_number_valid CHECK (
    week_number IS NULL OR week_number BETWEEN 1 AND 12
  ),
  CONSTRAINT videos_schedule_fields_valid CHECK (
    (type = 'base_lesson' AND day_of_week IS NULL AND week_number IS NULL)
    OR
    (type = 'workout' AND day_of_week IS NOT NULL AND week_number IS NOT NULL)
  ),
  CONSTRAINT videos_duration_positive CHECK (duration_seconds > 0),
  CONSTRAINT videos_storage_key_not_blank CHECK (btrim(storage_key) <> ''),
  CONSTRAINT videos_poster_key_not_blank CHECK (
    poster_key IS NULL OR btrim(poster_key) <> ''
  ),
  CONSTRAINT videos_status_valid CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT videos_order_index_valid CHECK (order_index >= 0)
);

DROP TRIGGER IF EXISTS videos_set_updated_at ON videos;
CREATE TRIGGER videos_set_updated_at
BEFORE UPDATE ON videos
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS videos_workout_schedule_unique_idx
  ON videos (week_number, day_of_week)
  WHERE type = 'workout';

CREATE INDEX IF NOT EXISTS videos_type_status_order_idx
  ON videos (type, status, order_index);

CREATE TABLE IF NOT EXISTS program_weeks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_number smallint NOT NULL,
  title varchar(255) NOT NULL,
  description text NULL,
  status varchar(32) NOT NULL DEFAULT 'locked',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT program_weeks_number_unique UNIQUE (week_number),
  CONSTRAINT program_weeks_number_valid CHECK (week_number BETWEEN 1 AND 12),
  CONSTRAINT program_weeks_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT program_weeks_status_valid CHECK (status IN ('locked', 'active', 'completed'))
);

CREATE INDEX IF NOT EXISTS program_weeks_status_number_idx
  ON program_weeks (status, week_number);

CREATE TABLE IF NOT EXISTS program_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_week_id uuid NOT NULL,
  day_of_week smallint NOT NULL,
  direction varchar(32) NOT NULL,
  title varchar(255) NOT NULL,
  description text NULL,
  duration_minutes integer NOT NULL,
  icon varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT program_days_program_week_fk FOREIGN KEY (program_week_id)
    REFERENCES program_weeks(id) ON DELETE CASCADE,
  CONSTRAINT program_days_week_day_unique UNIQUE (program_week_id, day_of_week),
  CONSTRAINT program_days_day_of_week_valid CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT program_days_direction_valid CHECK (
    direction IN (
      'breathing',
      'strength',
      'body_therapy',
      'functional',
      'stretching',
      'neuro',
      'recovery'
    )
  ),
  CONSTRAINT program_days_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT program_days_duration_positive CHECK (duration_minutes > 0),
  CONSTRAINT program_days_icon_not_blank CHECK (btrim(icon) <> '')
);

CREATE INDEX IF NOT EXISTS program_days_week_direction_idx
  ON program_days (program_week_id, direction);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider varchar(32) NOT NULL,
  provider_subscription_id varchar(255) NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  starts_at timestamptz NULL,
  expires_at timestamptz NULL,
  amount_minor integer NULL,
  currency varchar(16) NULL,
  raw_payload jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT subscriptions_user_fk FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT subscriptions_provider_valid CHECK (provider IN ('yukassa', 'tribute')),
  CONSTRAINT subscriptions_provider_id_not_blank CHECK (
    provider_subscription_id IS NULL OR btrim(provider_subscription_id) <> ''
  ),
  CONSTRAINT subscriptions_status_valid CHECK (
    status IN ('pending', 'active', 'expired', 'cancelled', 'refunded')
  ),
  CONSTRAINT subscriptions_period_valid CHECK (
    starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at
  ),
  CONSTRAINT subscriptions_amount_valid CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CONSTRAINT subscriptions_currency_valid CHECK (
    currency IS NULL OR currency ~ '^[A-Z]{3}$'
  )
);

DROP TRIGGER IF EXISTS subscriptions_set_updated_at ON subscriptions;
CREATE TRIGGER subscriptions_set_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_external_unique_idx
  ON subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscriptions_user_status_expires_idx
  ON subscriptions (user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS video_progress (
  user_id uuid NOT NULL,
  video_id uuid NOT NULL,
  position_seconds integer NOT NULL DEFAULT 0,
  completion_percent numeric(5, 2) NOT NULL DEFAULT 0,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, video_id),
  CONSTRAINT video_progress_user_fk FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT video_progress_video_fk FOREIGN KEY (video_id)
    REFERENCES videos(id) ON DELETE CASCADE,
  CONSTRAINT video_progress_position_valid CHECK (position_seconds >= 0),
  CONSTRAINT video_progress_completion_valid CHECK (
    completion_percent BETWEEN 0 AND 100
  ),
  CONSTRAINT video_progress_completed_state_valid CHECK (
    completed_at IS NULL OR completion_percent = 100
  )
);

DROP TRIGGER IF EXISTS video_progress_set_updated_at ON video_progress;
CREATE TRIGGER video_progress_set_updated_at
BEFORE UPDATE ON video_progress
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS video_progress_video_completion_idx
  ON video_progress (video_id, completion_percent);

CREATE TABLE IF NOT EXISTS workout_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  video_id uuid NOT NULL,
  program_week smallint NOT NULL,
  workout_date date NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT NOW(),
  source varchar(32) NOT NULL,
  CONSTRAINT workout_completions_user_fk FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT workout_completions_video_fk FOREIGN KEY (video_id)
    REFERENCES videos(id) ON DELETE CASCADE,
  CONSTRAINT workout_completions_user_video_week_unique UNIQUE (
    user_id,
    video_id,
    program_week
  ),
  CONSTRAINT workout_completions_program_week_valid CHECK (program_week BETWEEN 1 AND 12),
  CONSTRAINT workout_completions_source_valid CHECK (source IN ('player', 'manual_admin'))
);

CREATE INDEX IF NOT EXISTS workout_completions_user_date_idx
  ON workout_completions (user_id, workout_date DESC);

CREATE INDEX IF NOT EXISTS workout_completions_video_idx
  ON workout_completions (video_id);

CREATE TABLE IF NOT EXISTS weekly_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  program_week smallint NOT NULL,
  energy smallint NOT NULL,
  sleep smallint NOT NULL,
  mood smallint NOT NULL,
  body_satisfaction smallint NOT NULL,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT weekly_metrics_user_fk FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT weekly_metrics_user_week_unique UNIQUE (user_id, program_week),
  CONSTRAINT weekly_metrics_program_week_valid CHECK (program_week BETWEEN 1 AND 12),
  CONSTRAINT weekly_metrics_energy_valid CHECK (energy BETWEEN 1 AND 10),
  CONSTRAINT weekly_metrics_sleep_valid CHECK (sleep BETWEEN 1 AND 10),
  CONSTRAINT weekly_metrics_mood_valid CHECK (mood BETWEEN 1 AND 10),
  CONSTRAINT weekly_metrics_body_satisfaction_valid CHECK (
    body_satisfaction BETWEEN 1 AND 10
  )
);

CREATE INDEX IF NOT EXISTS weekly_metrics_week_idx
  ON weekly_metrics (program_week, created_at DESC);

CREATE TABLE IF NOT EXISTS achievements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(64) NOT NULL,
  title varchar(255) NOT NULL,
  description text NULL,
  icon_key text NOT NULL,
  rule_type varchar(64) NOT NULL,
  rule_value integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT achievements_code_unique UNIQUE (code),
  CONSTRAINT achievements_code_normalized CHECK (
    code = lower(btrim(code))
    AND code ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
  ),
  CONSTRAINT achievements_title_not_blank CHECK (btrim(title) <> ''),
  CONSTRAINT achievements_icon_key_not_blank CHECK (btrim(icon_key) <> ''),
  CONSTRAINT achievements_rule_type_not_blank CHECK (btrim(rule_type) <> ''),
  CONSTRAINT achievements_rule_value_positive CHECK (rule_value > 0)
);

CREATE INDEX IF NOT EXISTS achievements_rule_idx
  ON achievements (rule_type, rule_value);

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id uuid NOT NULL,
  achievement_id uuid NOT NULL,
  unlocked_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, achievement_id),
  CONSTRAINT user_achievements_user_fk FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT user_achievements_achievement_fk FOREIGN KEY (achievement_id)
    REFERENCES achievements(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_achievements_achievement_unlocked_idx
  ON user_achievements (achievement_id, unlocked_at DESC);
