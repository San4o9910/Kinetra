CREATE TABLE IF NOT EXISTS workout_sessions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  program_week smallint NOT NULL CHECK (program_week BETWEEN 1 AND 12),
  position_seconds integer NOT NULL DEFAULT 0 CHECK (position_seconds BETWEEN 0 AND 86400),
  difficulty smallint CHECK (difficulty BETWEEN 1 AND 5),
  wellbeing smallint CHECK (wellbeing BETWEEN 1 AND 5),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id, program_week)
);
CREATE INDEX IF NOT EXISTS workout_sessions_recent ON workout_sessions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workout_guides (
  video_id uuid PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  equipment jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(equipment) = 'array'),
  chapters jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(chapters) = 'array'),
  technique text NOT NULL DEFAULT '' CHECK (length(technique) <= 5000),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coach_daily_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  usage_day date NOT NULL,
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  PRIMARY KEY (user_id, usage_day)
);
CREATE TABLE IF NOT EXISTS coach_messages (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  use_progress boolean NOT NULL DEFAULT false,
  answer text CHECK (length(answer) <= 10000),
  status text NOT NULL CHECK (status IN ('pending','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coach_messages_user_recent ON coach_messages(user_id, created_at DESC);
