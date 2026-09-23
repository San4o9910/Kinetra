CREATE TABLE nutrition_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id uuid REFERENCES training_students(id) ON DELETE SET NULL,
  recorded_date date NOT NULL,
  slot text NOT NULL CHECK (slot IN ('breakfast','lunch','dinner','snack')),
  title text NOT NULL DEFAULT '' CHECK (length(title)<=120),
  items jsonb NOT NULL CHECK (jsonb_typeof(items)='array' AND jsonb_array_length(items) BETWEEN 1 AND 40),
  note text NOT NULL DEFAULT '' CHECK (length(note)<=1000),
  share_with_trainer boolean NOT NULL DEFAULT false,
  photo_id uuid UNIQUE,
  photo_bytes bigint NOT NULL DEFAULT 0 CHECK (photo_bytes BETWEEN 0 AND 5242880),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nutrition_entries_client_date ON nutrition_entries(client_id,recorded_date);
CREATE INDEX nutrition_entries_student_date ON nutrition_entries(student_id,recorded_date) WHERE share_with_trainer;
CREATE TABLE nutrition_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('portion','meal','day')),
  meals jsonb NOT NULL CHECK (jsonb_typeof(meals)='array' AND jsonb_array_length(meals) BETWEEN 1 AND 12),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nutrition_templates_client ON nutrition_templates(client_id,created_at);
CREATE TABLE nutrition_template_applications (
  client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  template_id uuid NOT NULL,
  recorded_date date NOT NULL,
  share_with_trainer boolean NOT NULL,
  entry_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(client_id,request_id)
);
CREATE TABLE trainer_quality_reviews (
  trainer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(trainer_id,client_id),
  CHECK(trainer_id<>client_id)
);
