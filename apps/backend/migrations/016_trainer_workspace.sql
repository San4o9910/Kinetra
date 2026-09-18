-- Personal training is separate from the platform's optional introductory course.
CREATE TABLE training_students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid NOT NULL REFERENCES trainer_profiles(user_id) ON DELETE CASCADE,
  client_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  contact text NOT NULL DEFAULT '' CHECK (length(contact) <= 200),
  invite_hash char(64) UNIQUE,
  invite_expires_at timestamptz,
  accepted_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (client_id IS NULL OR client_id <> trainer_id)
);
CREATE UNIQUE INDEX training_students_one_trainer ON training_students(client_id) WHERE archived_at IS NULL AND client_id IS NOT NULL;
CREATE INDEX training_students_owner ON training_students(trainer_id,created_at DESC);
CREATE TABLE training_lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid NOT NULL REFERENCES trainer_profiles(user_id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploading','ready','failed','archived')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 268435456),
  duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 7200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX training_lessons_owner ON training_lessons(trainer_id,created_at DESC);
CREATE TABLE training_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES training_students(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  goal text NOT NULL DEFAULT '' CHECK (length(goal) <= 2000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX training_plans_student ON training_plans(student_id,created_at DESC);
CREATE UNIQUE INDEX training_plans_current ON training_plans(student_id) WHERE status='published';
CREATE TABLE training_workouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  instructions text NOT NULL DEFAULT '' CHECK (length(instructions) <= 5000),
  scheduled_date date,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 240),
  lesson_id uuid REFERENCES training_lessons(id) ON DELETE SET NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 99)
);
CREATE INDEX training_workouts_plan ON training_workouts(plan_id,position);
CREATE TABLE training_logs (
  workout_id uuid PRIMARY KEY REFERENCES training_workouts(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at timestamptz,
  position_seconds integer NOT NULL DEFAULT 0 CHECK (position_seconds BETWEEN 0 AND 7200),
  difficulty smallint CHECK (difficulty BETWEEN 1 AND 5),
  wellbeing smallint CHECK (wellbeing BETWEEN 1 AND 5),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Existing explicit chat assignments remain available in the new workspace.
INSERT INTO training_students(trainer_id,client_id,name,accepted_at)
SELECT c.trainer_user_id,c.client_user_id,left(COALESCE(NULLIF(u.first_name,''),NULLIF(u.username,''),split_part(u.email,'@',1),'Ученик'),120),c.created_at
FROM chat_conversations c JOIN users u ON u.id=c.client_user_id JOIN trainer_profiles t ON t.user_id=c.trainer_user_id
WHERE t.is_active=true;
