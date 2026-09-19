import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { AssignedTrainingLesson } from '@kinetra/shared';
import { trainingError, trainingId, type TrainingService } from './service.js';
import { uuid } from './schema.js';
const assignmentSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('all') }).strict(),
  z
    .object({
      target: z.literal('selected'),
      student_ids: z
        .array(uuid)
        .min(1)
        .max(500)
        .refine((v) => new Set(v).size === v.length),
    })
    .strict(),
]);
const progressSchema = z
  .object({
    position_seconds: z.number().int().min(0).max(7200).optional(),
    completed: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const assignedLessons = async (
  db: Pool | PoolClient,
  student: string,
): Promise<AssignedTrainingLesson[]> => {
  const result = await db.query(
    `SELECT l.id,l.title,l.description,l.audience,l.duration_seconds,a.assigned_at,a.position_seconds,a.completed_at
    FROM training_lesson_assignments a JOIN training_lessons l ON l.id=a.lesson_id
    JOIN training_students s ON s.id=a.student_id AND s.trainer_id=l.trainer_id
    JOIN trainer_profiles t ON t.user_id=s.trainer_id AND t.is_active=true
    WHERE a.student_id=$1 AND a.revoked_at IS NULL AND s.archived_at IS NULL AND l.status='ready'
    AND (l.audience='shared' OR l.personal_student_id=s.id) ORDER BY a.assigned_at DESC,l.id`,
    [student],
  );
  return result.rows;
};
export class LessonAssignments {
  constructor(private readonly training: TrainingService) {}
  async recipients(trainer: string, id: string) {
    return this.training.transaction(async (db) => {
      await this.training.trainer(db, trainer);
      const lesson = await db.query(
        "SELECT id FROM training_lessons WHERE id=$1 AND trainer_id=$2 AND status<>'archived' FOR SHARE",
        [trainingId(id), trainer],
      );
      if (!lesson.rows[0]) trainingError(404, 'LESSON_UNAVAILABLE', 'Урок недоступен.');
      const result = await db.query(
        `SELECT s.id,s.name,s.client_id,a.position_seconds,a.completed_at,a.assigned_at FROM training_lesson_assignments a JOIN training_students s ON s.id=a.student_id WHERE a.lesson_id=$1 AND s.trainer_id=$2 AND s.archived_at IS NULL AND a.revoked_at IS NULL ORDER BY s.name,s.id`,
        [id, trainer],
      );
      return { recipients: result.rows };
    });
  }
  async assign(trainer: string, id: string, body: unknown) {
    const parsed = assignmentSchema.safeParse(body);
    if (!parsed.success)
      trainingError(400, 'INVALID_RECIPIENTS', 'Выберите одного или нескольких учеников.');
    return this.training.transaction(async (db) => {
      await this.training.trainer(db, trainer);
      // Lock students before lessons, matching savePlan/assignTemplate. "All" is a snapshot.
      const students = await db.query(
        `SELECT id FROM training_students WHERE trainer_id=$1 AND archived_at IS NULL ${parsed.data.target === 'selected' ? 'AND id=ANY($2::uuid[])' : ''} ORDER BY id FOR SHARE`,
        parsed.data.target === 'selected' ? [trainer, parsed.data.student_ids] : [trainer],
      );
      if (
        !students.rows.length ||
        (parsed.data.target === 'selected' &&
          students.rows.length !== parsed.data.student_ids.length)
      )
        trainingError(400, 'INVALID_RECIPIENTS', 'Один из учеников недоступен. Обновите список.');
      const result = await db.query(
        "SELECT audience,personal_student_id FROM training_lessons WHERE id=$1 AND trainer_id=$2 AND status='ready' FOR SHARE",
        [trainingId(id), trainer],
      );
      const lesson = result.rows[0];
      if (!lesson) trainingError(404, 'LESSON_UNAVAILABLE', 'Дождитесь готовности видео.');
      if (
        lesson.audience === 'personal' &&
        (parsed.data.target === 'all' ||
          students.rows.some((s) => s.id !== lesson.personal_student_id))
      )
        trainingError(
          409,
          'PERSONAL_LESSON',
          'Персональный урок доступен только выбранному при создании ученику.',
        );
      await db.query(
        `INSERT INTO training_lesson_assignments(lesson_id,student_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT(lesson_id,student_id) DO UPDATE SET assigned_at=CASE WHEN training_lesson_assignments.revoked_at IS NULL THEN training_lesson_assignments.assigned_at ELSE now() END,revoked_at=NULL`,
        [id, students.rows.map((s) => s.id)],
      );
      return { assigned: students.rows.length };
    });
  }
  async revoke(trainer: string, id: string, student: string) {
    return this.training.transaction(async (db) => {
      await this.training.student(db, trainer, trainingId(student), false);
      const lesson = await db.query(
        'SELECT id FROM training_lessons WHERE id=$1 AND trainer_id=$2 FOR SHARE',
        [trainingId(id), trainer],
      );
      if (!lesson.rows[0]) trainingError(404, 'LESSON_UNAVAILABLE', 'Урок недоступен.');
      await db.query(
        'UPDATE training_lesson_assignments SET revoked_at=COALESCE(revoked_at,now()) WHERE lesson_id=$1 AND student_id=$2',
        [id, student],
      );
      return { saved: true };
    });
  }
  async progress(client: string, id: string, body: unknown) {
    const parsed = progressSchema.safeParse(body);
    if (!parsed.success) trainingError(400, 'INVALID_PROGRESS', 'Не удалось сохранить просмотр.');
    return this.training.transaction(async (db) => {
      const student = await db.query(
        `SELECT s.id FROM training_students s JOIN trainer_profiles t ON t.user_id=s.trainer_id AND t.is_active=true WHERE s.client_id=$1 AND s.archived_at IS NULL FOR SHARE OF s,t`,
        [client],
      );
      if (!student.rows[0]) trainingError(404, 'LESSON_UNAVAILABLE', 'Урок недоступен.');
      const result = await db.query(
        `SELECT l.id FROM training_lessons l JOIN training_students s ON s.trainer_id=l.trainer_id WHERE l.id=$1 AND s.id=$2 AND l.status='ready' AND (l.audience='shared' OR l.personal_student_id=s.id) FOR SHARE OF l`,
        [trainingId(id), student.rows[0].id],
      );
      if (!result.rows[0]) trainingError(404, 'LESSON_UNAVAILABLE', 'Урок недоступен.');
      const updated = await db.query(
        `UPDATE training_lesson_assignments SET position_seconds=GREATEST(position_seconds,COALESCE($3,0)),completed_at=CASE WHEN $4 THEN COALESCE(completed_at,now()) ELSE completed_at END WHERE lesson_id=$1 AND student_id=$2 AND revoked_at IS NULL RETURNING lesson_id`,
        [
          id,
          student.rows[0].id,
          parsed.data.position_seconds ?? null,
          parsed.data.completed ?? false,
        ],
      );
      if (!updated.rows[0])
        trainingError(404, 'LESSON_UNAVAILABLE', 'Урок больше не назначен вам.');
      return { saved: true };
    });
  }
}
