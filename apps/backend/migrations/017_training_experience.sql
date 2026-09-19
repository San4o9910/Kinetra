-- Additive upgrade: existing programs, videos and completion history stay intact.
ALTER TABLE training_workouts ADD COLUMN exercises jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(exercises)='array' AND jsonb_array_length(exercises)<=40);
ALTER TABLE training_logs ADD COLUMN set_records jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(set_records)='array' AND jsonb_array_length(set_records)<=800);
ALTER TABLE training_students ADD COLUMN reports_seen_at timestamptz;
CREATE TABLE training_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 trainer_id uuid NOT NULL REFERENCES trainer_profiles(user_id) ON DELETE CASCADE,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 goal text NOT NULL DEFAULT '', workouts jsonb NOT NULL CHECK(jsonb_typeof(workouts)='array'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX training_templates_owner ON training_templates(trainer_id,created_at DESC);
CREATE TABLE training_reschedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workout_id uuid NOT NULL REFERENCES training_workouts(id) ON DELETE CASCADE,
 client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 requested_date date NOT NULL,
 reason text NOT NULL DEFAULT '' CHECK(length(reason)<=1000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz
);
CREATE UNIQUE INDEX training_reschedules_pending ON training_reschedules(workout_id) WHERE status='pending';
CREATE TABLE training_measurements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 student_id uuid REFERENCES training_students(id) ON DELETE SET NULL,
 recorded_date date NOT NULL,
 weight_kg numeric(5,2) CHECK(weight_kg BETWEEN 20 AND 400),
 waist_cm numeric(5,1) CHECK(waist_cm BETWEEN 20 AND 300),
 chest_cm numeric(5,1) CHECK(chest_cm BETWEEN 20 AND 300),
 hips_cm numeric(5,1) CHECK(hips_cm BETWEEN 20 AND 300),
 note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
 share_with_trainer boolean NOT NULL DEFAULT false,
 photo_id uuid UNIQUE, photo_bytes integer CHECK(photo_bytes BETWEEN 1 AND 5242880),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX training_measurements_owner ON training_measurements(client_id,recorded_date DESC);
CREATE TABLE training_complaints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 trainer_id uuid NOT NULL REFERENCES trainer_profiles(user_id) ON DELETE CASCADE,
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000),
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewing','resolved')),
 resolution text NOT NULL DEFAULT '' CHECK(length(resolution)<=2000),
 revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX training_complaints_queue ON training_complaints(status,created_at);
CREATE TABLE training_complaint_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 complaint_id uuid NOT NULL REFERENCES training_complaints(id) ON DELETE CASCADE,
 actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 status text NOT NULL CHECK(status IN ('new','reviewing','resolved')),
 reason text NOT NULL CHECK(length(reason)<=2000), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE training_lessons DROP CONSTRAINT training_lessons_status_check;
ALTER TABLE training_lessons ADD CONSTRAINT training_lessons_status_check CHECK(status IN ('pending','uploading','processing','ready','failed','archived'));
ALTER TABLE training_lessons ADD COLUMN folder text NOT NULL DEFAULT '' CHECK(length(folder)<=80),
 ADD COLUMN original_name text NOT NULL DEFAULT '' CHECK(length(original_name)<=200),
 ADD COLUMN source_bytes bigint,
 ADD COLUMN upload_offset bigint NOT NULL DEFAULT 0,
 ADD COLUMN source_modified bigint,
 ADD COLUMN processing_started_at timestamptz,
 ADD COLUMN error_message text NOT NULL DEFAULT '' CHECK(length(error_message)<=500),
 ADD COLUMN thumbnail_ready boolean NOT NULL DEFAULT false;
UPDATE training_lessons SET source_bytes=size_bytes;
ALTER TABLE training_lessons ALTER COLUMN source_bytes SET NOT NULL;
ALTER TABLE training_lessons ADD CONSTRAINT training_lesson_source_bounds CHECK(source_bytes BETWEEN 1 AND 268435456 AND upload_offset BETWEEN 0 AND source_bytes);
ALTER TABLE training_logs ADD COLUMN progress_revision integer NOT NULL DEFAULT 0;
CREATE FUNCTION protect_training_complaint_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND pg_trigger_depth()>1 AND OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL
  AND (to_jsonb(NEW)-'actor_user_id')=(to_jsonb(OLD)-'actor_user_id') THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND pg_trigger_depth()>1 AND NOT EXISTS(SELECT 1 FROM training_complaints WHERE id=OLD.complaint_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'complaint history is append-only' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER training_complaint_events_append_only BEFORE UPDATE OR DELETE ON training_complaint_events FOR EACH ROW EXECUTE FUNCTION protect_training_complaint_history();
