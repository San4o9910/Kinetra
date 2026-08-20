CREATE TABLE IF NOT EXISTS survey_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  version integer NOT NULL,
  gender varchar(16) NOT NULL,
  age_range varchar(16) NOT NULL,
  goal varchar(32) NOT NULL,
  injuries text[] NOT NULL,
  injuries_detail text NULL,
  experience varchar(32) NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT survey_answers_user_fk FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT survey_answers_user_version_unique UNIQUE (user_id, version),
  CONSTRAINT survey_answers_version_positive CHECK (version > 0),
  CONSTRAINT survey_answers_gender_valid CHECK (gender IN ('male', 'female')),
  CONSTRAINT survey_answers_age_range_valid CHECK (
    age_range IN ('18-25', '26-35', '36-45', '46-55', '55+')
  ),
  CONSTRAINT survey_answers_goal_valid CHECK (
    goal IN ('flexibility', 'strength', 'awareness', 'general_health')
  ),
  CONSTRAINT survey_answers_experience_valid CHECK (
    experience IN ('beginner', 'novice', 'experienced')
  ),
  CONSTRAINT survey_answers_injuries_not_empty CHECK (
    cardinality(injuries) BETWEEN 1 AND 6
  ),
  CONSTRAINT survey_answers_injuries_no_nulls CHECK (
    array_position(injuries, NULL) IS NULL
  ),
  CONSTRAINT survey_answers_injuries_allowed CHECK (
    injuries <@ ARRAY[
      'none',
      'knees',
      'lower_back',
      'shoulders',
      'neck',
      'other'
    ]::text[]
  ),
  CONSTRAINT survey_answers_none_exclusive CHECK (
    NOT ('none' = ANY(injuries) AND cardinality(injuries) > 1)
  ),
  CONSTRAINT survey_answers_other_detail_valid CHECK (
    (
      'other' = ANY(injuries)
      AND injuries_detail IS NOT NULL
      AND btrim(injuries_detail) <> ''
    )
    OR
    (
      NOT ('other' = ANY(injuries))
      AND injuries_detail IS NULL
    )
  )
);

DROP TRIGGER IF EXISTS survey_answers_set_updated_at ON survey_answers;
CREATE TRIGGER survey_answers_set_updated_at
BEFORE UPDATE ON survey_answers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS survey_answers_one_current_idx
  ON survey_answers (user_id)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS survey_answers_user_history_idx
  ON survey_answers (user_id, version DESC);

CREATE INDEX IF NOT EXISTS survey_answers_current_lookup_idx
  ON survey_answers (user_id, created_at DESC)
  WHERE is_current = true;
