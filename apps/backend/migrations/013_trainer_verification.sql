ALTER TABLE users
  ADD COLUMN IF NOT EXISTS requested_role varchar(16);

UPDATE users AS user_record
SET requested_role = CASE
  WHEN EXISTS (
    SELECT 1
    FROM trainer_profiles AS profile
    WHERE profile.user_id = user_record.id
      AND profile.is_active = true
  ) THEN 'trainer'
  ELSE 'trainee'
END
WHERE requested_role IS NULL;

ALTER TABLE users
  ALTER COLUMN requested_role SET DEFAULT 'trainee',
  ALTER COLUMN requested_role SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_requested_role_valid'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_requested_role_valid
      CHECK (requested_role IN ('trainer', 'trainee'));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS trainer_verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status varchar(32) NOT NULL DEFAULT 'pending',
  display_name varchar(120) NULL,
  specialization varchar(160) NULL,
  experience_years smallint NULL,
  bio text NULL,
  city varchar(120) NULL,
  timezone varchar(64) NULL,
  submitted_at timestamptz NULL,
  reviewed_at timestamptz NULL,
  reviewer_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  review_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT trainer_verification_requests_status_valid CHECK (
    status IN ('pending', 'needs_more_info', 'approved', 'rejected', 'withdrawn')
  ),
  CONSTRAINT trainer_verification_requests_display_name_valid CHECK (
    display_name IS NULL OR (
      display_name = btrim(display_name)
      AND char_length(display_name) BETWEEN 1 AND 120
    )
  ),
  CONSTRAINT trainer_verification_requests_specialization_valid CHECK (
    specialization IS NULL OR (
      specialization = btrim(specialization)
      AND char_length(specialization) BETWEEN 1 AND 160
    )
  ),
  CONSTRAINT trainer_verification_requests_experience_valid CHECK (
    experience_years IS NULL OR experience_years BETWEEN 0 AND 80
  ),
  CONSTRAINT trainer_verification_requests_bio_valid CHECK (
    bio IS NULL OR (
      bio = btrim(bio)
      AND char_length(bio) BETWEEN 20 AND 2000
    )
  ),
  CONSTRAINT trainer_verification_requests_city_valid CHECK (
    city IS NULL OR (
      city = btrim(city)
      AND char_length(city) BETWEEN 1 AND 120
    )
  ),
  CONSTRAINT trainer_verification_requests_timezone_valid CHECK (
    timezone IS NULL OR (
      timezone = btrim(timezone)
      AND char_length(timezone) BETWEEN 1 AND 64
    )
  ),
  CONSTRAINT trainer_verification_requests_reason_valid CHECK (
    review_reason IS NULL OR (
      review_reason = btrim(review_reason)
      AND char_length(review_reason) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT trainer_verification_requests_submission_valid CHECK (
    submitted_at IS NULL OR (
      display_name IS NOT NULL
      AND specialization IS NOT NULL
      AND experience_years IS NOT NULL
      AND bio IS NOT NULL
      AND city IS NOT NULL
      AND timezone IS NOT NULL
    )
  ),
  CONSTRAINT trainer_verification_requests_review_valid CHECK (
    (
      status = 'pending'
      AND reviewed_at IS NULL
      AND reviewer_user_id IS NULL
      AND review_reason IS NULL
    )
    OR (
      status = 'withdrawn'
      AND reviewed_at IS NULL
      AND reviewer_user_id IS NULL
      AND review_reason IS NULL
      AND submitted_at IS NOT NULL
    )
    OR (
      status = 'approved'
      AND submitted_at IS NOT NULL
      AND reviewed_at IS NOT NULL
    )
    OR (
      status IN ('needs_more_info', 'rejected')
      AND submitted_at IS NOT NULL
      AND reviewed_at IS NOT NULL
      AND review_reason IS NOT NULL
    )
  )
);

DROP TRIGGER IF EXISTS trainer_verification_requests_set_updated_at
  ON trainer_verification_requests;
CREATE TRIGGER trainer_verification_requests_set_updated_at
BEFORE UPDATE ON trainer_verification_requests
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION prevent_direct_trainer_verification_request_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Preserve existing account deletion: the users FK cascade may remove the
  -- owned request, but application code cannot erase verification history
  -- directly while its owner still exists.
  IF pg_trigger_depth() > 1
    AND NOT EXISTS (
      SELECT 1
      FROM users
      WHERE id = OLD.user_id
    )
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'trainer verification requests may be deleted only with their owner account'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trainer_verification_requests_delete_guard
  ON trainer_verification_requests;
CREATE TRIGGER trainer_verification_requests_delete_guard
BEFORE DELETE ON trainer_verification_requests
FOR EACH ROW
EXECUTE FUNCTION prevent_direct_trainer_verification_request_delete();

CREATE UNIQUE INDEX IF NOT EXISTS trainer_verification_requests_one_live_per_user_idx
  ON trainer_verification_requests (user_id)
  WHERE status IN ('pending', 'needs_more_info', 'approved');

CREATE INDEX IF NOT EXISTS trainer_verification_requests_user_history_idx
  ON trainer_verification_requests (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS trainer_verification_requests_review_queue_idx
  ON trainer_verification_requests (status, submitted_at, created_at, id)
  WHERE submitted_at IS NOT NULL
    AND status IN ('pending', 'needs_more_info');

CREATE TABLE IF NOT EXISTS trainer_verification_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES trainer_verification_requests(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL,
  url text NOT NULL,
  title varchar(160) NOT NULL,
  issued_at date NULL,
  expires_at date NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT trainer_verification_documents_kind_valid CHECK (
    kind IN ('professional_profile', 'certificate', 'diploma', 'portfolio', 'other')
  ),
  CONSTRAINT trainer_verification_documents_url_valid CHECK (
    url = btrim(url)
    AND url ~ '^https://'
    AND char_length(url) BETWEEN 9 AND 2048
  ),
  CONSTRAINT trainer_verification_documents_title_valid CHECK (
    title = btrim(title)
    AND char_length(title) BETWEEN 1 AND 160
  ),
  CONSTRAINT trainer_verification_documents_dates_valid CHECK (
    expires_at IS NULL OR issued_at IS NULL OR expires_at >= issued_at
  )
);

CREATE INDEX IF NOT EXISTS trainer_verification_documents_request_idx
  ON trainer_verification_documents (request_id, created_at, id);

CREATE TABLE IF NOT EXISTS trainer_verification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES trainer_verification_requests(id) ON DELETE CASCADE,
  actor_user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  from_status varchar(32) NULL,
  to_status varchar(32) NOT NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT trainer_verification_events_from_status_valid CHECK (
    from_status IS NULL
    OR from_status IN ('pending', 'needs_more_info', 'approved', 'rejected', 'withdrawn')
  ),
  CONSTRAINT trainer_verification_events_to_status_valid CHECK (
    to_status IN ('pending', 'needs_more_info', 'approved', 'rejected', 'withdrawn')
  ),
  CONSTRAINT trainer_verification_events_reason_valid CHECK (
    reason IS NULL OR (
      reason = btrim(reason)
      AND char_length(reason) BETWEEN 1 AND 1000
    )
  )
);

CREATE INDEX IF NOT EXISTS trainer_verification_events_request_idx
  ON trainer_verification_events (request_id, created_at, id);

CREATE OR REPLACE FUNCTION prevent_trainer_verification_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Account deletion may invoke the actor FK's ON DELETE SET NULL as a nested
  -- update. Permit only that exact referential action; every audit value stays
  -- immutable and direct event mutation remains forbidden.
  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() > 1
      AND OLD.actor_user_id IS NOT NULL
      AND NEW.actor_user_id IS NULL
      AND NEW.id = OLD.id
      AND NEW.request_id = OLD.request_id
      AND NEW.from_status IS NOT DISTINCT FROM OLD.from_status
      AND NEW.to_status = OLD.to_status
      AND NEW.reason IS NOT DISTINCT FROM OLD.reason
      AND NEW.created_at = OLD.created_at
    THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1
      AND NOT EXISTS (
        SELECT 1
        FROM trainer_verification_requests
        WHERE id = OLD.request_id
      )
    THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'trainer verification events are append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trainer_verification_events_append_only
  ON trainer_verification_events;
CREATE TRIGGER trainer_verification_events_append_only
BEFORE UPDATE OR DELETE ON trainer_verification_events
FOR EACH ROW
EXECUTE FUNCTION prevent_trainer_verification_event_mutation();

CREATE TABLE IF NOT EXISTS trainer_verification_reviewers (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trainer_verification_reviewers_set_updated_at
  ON trainer_verification_reviewers;
CREATE TRIGGER trainer_verification_reviewers_set_updated_at
BEFORE UPDATE ON trainer_verification_reviewers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION align_requested_role_with_active_trainer_profile()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_active = true THEN
    UPDATE users
    SET requested_role = 'trainer'
    WHERE id = NEW.user_id
      AND requested_role <> 'trainer';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trainer_profiles_align_requested_role ON trainer_profiles;
CREATE TRIGGER trainer_profiles_align_requested_role
AFTER INSERT OR UPDATE OF is_active ON trainer_profiles
FOR EACH ROW
EXECUTE FUNCTION align_requested_role_with_active_trainer_profile();
