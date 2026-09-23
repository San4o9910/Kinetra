-- Additive catalogue foundation. Existing clients, chats, plans and access are unchanged.
-- Publication is an explicit reviewer decision; draft edits never replace the public snapshot.
CREATE TABLE marketplace_profiles (
  id uuid PRIMARY KEY REFERENCES trainer_profiles(user_id) ON DELETE CASCADE,
  trainer_id uuid NOT NULL UNIQUE REFERENCES trainer_profiles(user_id) ON DELETE CASCADE,
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  published jsonb CHECK (published IS NULL OR jsonb_typeof(published) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  review_state text NOT NULL DEFAULT 'draft' CHECK (review_state IN ('draft','pending','approved','changes_requested','suspended')),
  review_note text NOT NULL DEFAULT '' CHECK (length(review_note) <= 2000),
  is_listed boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id = trainer_id),
  CHECK (NOT is_listed OR (published IS NOT NULL AND published_at IS NOT NULL))
);
CREATE TABLE marketplace_offers (
  id uuid PRIMARY KEY,
  trainer_id uuid NOT NULL REFERENCES trainer_profiles(user_id) ON DELETE CASCADE,
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  published jsonb CHECK (published IS NULL OR jsonb_typeof(published) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  review_state text NOT NULL DEFAULT 'draft' CHECK (review_state IN ('draft','pending','approved','changes_requested','suspended')),
  review_note text NOT NULL DEFAULT '' CHECK (length(review_note) <= 2000),
  is_listed boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_listed OR (published IS NOT NULL AND published_at IS NOT NULL))
);
CREATE INDEX marketplace_offers_owner ON marketplace_offers(trainer_id, updated_at DESC, id);
CREATE INDEX marketplace_offers_public ON marketplace_offers(published_at DESC, id) WHERE is_listed;
CREATE INDEX marketplace_profiles_review ON marketplace_profiles(updated_at, id) WHERE review_state='pending';
CREATE INDEX marketplace_offers_review ON marketplace_offers(updated_at, id) WHERE review_state='pending';
CREATE TABLE marketplace_publication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL CHECK (entity IN ('profile','offer')),
  entity_id uuid NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('submit','approve','request_changes','pause','suspend')),
  revision integer NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marketplace_publication_history ON marketplace_publication_events(entity,entity_id,created_at);
