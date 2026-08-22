ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS payment_method_id text;

ALTER TABLE subscriptions
  ALTER COLUMN auto_renew SET DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'subscriptions_payment_method_id_not_blank'
      AND conrelid = 'subscriptions'::regclass
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_payment_method_id_not_blank CHECK (
        payment_method_id IS NULL OR btrim(payment_method_id) <> ''
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS subscription_payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL,
  user_id uuid NOT NULL,
  provider_payment_id text NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'creating',
  idempotency_key uuid NOT NULL,
  renews_expires_at timestamptz NULL,
  return_url text NULL,
  confirmation_url text NULL,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT subscription_payment_attempts_subscription_fk FOREIGN KEY (subscription_id)
    REFERENCES subscriptions(id) ON DELETE CASCADE,
  CONSTRAINT subscription_payment_attempts_user_fk FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT subscription_payment_attempts_provider_payment_not_blank CHECK (
    provider_payment_id IS NULL OR btrim(provider_payment_id) <> ''
  ),
  CONSTRAINT subscription_payment_attempts_kind_valid CHECK (
    kind IN ('initial', 'renewal')
  ),
  CONSTRAINT subscription_payment_attempts_status_valid CHECK (
    status IN ('creating', 'pending', 'succeeded', 'cancelled', 'refunded', 'failed')
  ),
  CONSTRAINT subscription_payment_attempts_renewal_target_valid CHECK (
    (kind = 'initial' AND renews_expires_at IS NULL)
    OR (kind = 'renewal' AND renews_expires_at IS NOT NULL)
  ),
  CONSTRAINT subscription_payment_attempts_return_url_valid CHECK (
    (kind = 'initial' AND return_url IS NOT NULL AND btrim(return_url) <> '')
    OR (kind = 'renewal' AND return_url IS NULL)
  ),
  CONSTRAINT subscription_payment_attempts_raw_payload_object CHECK (
    jsonb_typeof(raw_payload) = 'object'
  )
);

DROP TRIGGER IF EXISTS subscription_payment_attempts_set_updated_at
  ON subscription_payment_attempts;
CREATE TRIGGER subscription_payment_attempts_set_updated_at
BEFORE UPDATE ON subscription_payment_attempts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS subscription_payment_attempts_provider_payment_unique_idx
  ON subscription_payment_attempts (provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_payment_attempts_idempotency_unique_idx
  ON subscription_payment_attempts (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS subscription_payment_attempts_open_initial_user_unique_idx
  ON subscription_payment_attempts (user_id)
  WHERE kind = 'initial' AND status IN ('creating', 'pending');

CREATE UNIQUE INDEX IF NOT EXISTS subscription_payment_attempts_open_renewal_unique_idx
  ON subscription_payment_attempts (subscription_id, renews_expires_at)
  WHERE kind = 'renewal' AND status IN ('creating', 'pending');

CREATE INDEX IF NOT EXISTS subscription_payment_attempts_subscription_status_idx
  ON subscription_payment_attempts (subscription_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS subscription_payment_attempts_user_idx
  ON subscription_payment_attempts (user_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  event_id text NOT NULL,
  payment_id text NOT NULL,
  user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL,
  raw_payload jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_events_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT payment_events_event_id_not_blank CHECK (btrim(event_id) <> ''),
  CONSTRAINT payment_events_payment_id_not_blank CHECK (btrim(payment_id) <> ''),
  CONSTRAINT payment_events_status_valid CHECK (status IN ('processed', 'ignored')),
  CONSTRAINT payment_events_raw_payload_object CHECK (jsonb_typeof(raw_payload) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_events_event_id_unique_idx
  ON payment_events (event_id);

CREATE INDEX IF NOT EXISTS payment_events_payment_id_idx
  ON payment_events (payment_id);

CREATE INDEX IF NOT EXISTS payment_events_user_id_idx
  ON payment_events (user_id);

CREATE INDEX IF NOT EXISTS subscriptions_due_renewal_idx
  ON subscriptions (expires_at, id)
  WHERE status = 'active' AND auto_renew = true;
