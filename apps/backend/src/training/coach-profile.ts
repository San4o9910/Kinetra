import { coachLevel, type CoachMetrics, type CoachProfile } from '@kinetra/shared';
import { z } from 'zod';
import { type TrainingService, trainingError } from './service.js';
export class CoachProfiles {
  public constructor(private readonly service: TrainingService) {}
  public async profile(trainer: string): Promise<CoachProfile> {
    await this.service.trainer(this.service.pool, trainer);
    const r = await this.service.pool.query<CoachMetrics & { display_name: string }>(
      `SELECT t.display_name,
      (SELECT count(*)::int FROM training_students WHERE trainer_id=t.user_id AND archived_at IS NULL AND client_id IS NOT NULL) active_students,
      (SELECT count(*)::int FROM training_lessons WHERE trainer_id=t.user_id AND status='ready') ready_lessons,
      (SELECT count(*)::int FROM trainer_quality_reviews WHERE trainer_id=t.user_id) review_count,
      (SELECT avg(score)::float8 FROM trainer_quality_reviews WHERE trainer_id=t.user_id) rating
      FROM trainer_profiles t WHERE t.user_id=$1 AND t.is_active`,
      [trainer],
    );
    const metrics = r.rows[0]!;
    return { ...metrics, ...coachLevel(metrics) };
  }
  public async mine(user: string) {
    const r = await this.service.pool.query(
      `SELECT s.trainer_id,r.score,
      (EXISTS(SELECT 1 FROM training_logs l JOIN training_workouts w ON w.id=l.workout_id JOIN training_plans p ON p.id=w.plan_id WHERE p.student_id=s.id AND l.completed_at IS NOT NULL)
       OR EXISTS(SELECT 1 FROM training_lesson_assignments a WHERE a.student_id=s.id AND a.completed_at IS NOT NULL)) can_review
      FROM training_students s JOIN trainer_profiles t ON t.user_id=s.trainer_id AND t.is_active LEFT JOIN trainer_quality_reviews r ON r.trainer_id=s.trainer_id AND r.client_id=$1 WHERE s.client_id=$1 AND s.archived_at IS NULL`,
      [user],
    );
    const row = r.rows[0];
    return {
      profile: row ? await this.profile(row.trainer_id) : null,
      score: (row?.score ?? null) as number | null,
      can_review: row?.can_review === true,
    };
  }
  public async review(user: string, body: unknown) {
    const parsed = z
      .object({ score: z.number().int().min(1).max(5) })
      .strict()
      .safeParse(body);
    if (!parsed.success) trainingError(400, 'INVALID_RATING', 'Выберите оценку от 1 до 5.');
    return this.service.transaction(async (db) => {
      const r = await db.query(
        `SELECT s.id,s.trainer_id FROM training_students s JOIN trainer_profiles t ON t.user_id=s.trainer_id AND t.is_active WHERE s.client_id=$1 AND s.archived_at IS NULL FOR SHARE OF s,t`,
        [user],
      );
      const row = r.rows[0];
      if (!row) trainingError(404, 'TRAINER_NOT_CONNECTED', 'Подключитесь к тренеру.');
      const completed = await db.query(
        `SELECT 1 WHERE EXISTS(SELECT 1 FROM training_logs l JOIN training_workouts w ON w.id=l.workout_id JOIN training_plans p ON p.id=w.plan_id WHERE p.student_id=$1 AND l.completed_at IS NOT NULL) OR EXISTS(SELECT 1 FROM training_lesson_assignments WHERE student_id=$1 AND completed_at IS NOT NULL)`,
        [row.id],
      );
      if (!completed.rowCount)
        trainingError(
          409,
          'TRAINING_REQUIRED',
          'Оценка доступна после первого выполненного занятия или урока.',
        );
      await db.query(
        'INSERT INTO trainer_quality_reviews(trainer_id,client_id,score) VALUES($1,$2,$3) ON CONFLICT(trainer_id,client_id) DO UPDATE SET score=EXCLUDED.score,updated_at=now()',
        [row.trainer_id, user, parsed.data.score],
      );
      return { saved: true };
    });
  }
}
