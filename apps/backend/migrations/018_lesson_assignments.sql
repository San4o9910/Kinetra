-- An uploaded lesson stays private until explicitly assigned or used in a published plan.
ALTER TABLE training_lessons ADD COLUMN audience text NOT NULL DEFAULT 'shared' CHECK (audience IN ('shared','personal'));
ALTER TABLE training_lessons ADD COLUMN personal_student_id uuid REFERENCES training_students(id) ON DELETE CASCADE;
ALTER TABLE training_lessons ADD CONSTRAINT training_lessons_personal_owner CHECK ((audience='personal') = (personal_student_id IS NOT NULL));
CREATE TABLE training_lesson_assignments (
  lesson_id uuid NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES training_students(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  position_seconds integer NOT NULL DEFAULT 0 CHECK (position_seconds BETWEEN 0 AND 7200),
  completed_at timestamptz,
  PRIMARY KEY(lesson_id,student_id)
);
CREATE INDEX training_lesson_assignments_student ON training_lesson_assignments(student_id,assigned_at DESC) WHERE revoked_at IS NULL;
