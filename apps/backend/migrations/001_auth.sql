CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(320) NULL,
  phone varchar(32) NULL,
  password_hash text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  email_verified_at timestamptz NULL,
  avatar_url text NULL,
  username varchar(255) NULL,
  first_name varchar(255) NULL,
  onboarding_status varchar(32) NOT NULL DEFAULT 'survey_pending',
  notification_enabled boolean NOT NULL DEFAULT true,
  level varchar(32) NOT NULL DEFAULT 'beginner',
  timezone varchar(64) NOT NULL DEFAULT 'Europe/Moscow',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT users_identifier_required CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CONSTRAINT users_email_normalized CHECK (email IS NULL OR email = lower(btrim(email))),
  CONSTRAINT users_phone_normalized CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_phone_unique UNIQUE (phone),
  CONSTRAINT users_onboarding_status_valid CHECK (
    onboarding_status IN ('survey_pending', 'onboarding_pending', 'base_lessons', 'active')
  ),
  CONSTRAINT users_level_valid CHECK (level IN ('beginner', 'intermediate', 'advanced'))
);

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  replaced_by_token_id uuid NULL REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT refresh_tokens_hash_unique UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT refresh_tokens_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT refresh_tokens_replacement_valid CHECK (
    replaced_by_token_id IS NULL OR replaced_by_token_id <> id
  )
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_active_idx
  ON refresh_tokens (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT password_reset_tokens_hash_unique UNIQUE (token_hash),
  CONSTRAINT password_reset_tokens_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT password_reset_tokens_expiry_valid CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_one_outstanding_idx
  ON password_reset_tokens (user_id)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx
  ON password_reset_tokens (expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT email_verification_tokens_hash_unique UNIQUE (token_hash),
  CONSTRAINT email_verification_tokens_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_verification_tokens_expiry_valid CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS email_verification_tokens_one_outstanding_idx
  ON email_verification_tokens (user_id)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS email_verification_tokens_expiry_idx
  ON email_verification_tokens (expires_at)
  WHERE used_at IS NULL;
