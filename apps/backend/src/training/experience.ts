import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TrainingAttention, TrainingWorkoutInput } from '@kinetra/shared';
import { type TrainingService, trainingError, trainingId } from './service.js';
import {
  complaintSchema,
  complaintReviewSchema,
  measurementSchema,
  planSchema,
  rescheduleSchema,
  date,
} from './schema.js';

export class TrainingExperience {
  public constructor(public readonly training: TrainingService) {}
  private async reviewer(db: PoolClient, user: string) {
    const r = await db.query(
      'SELECT user_id FROM trainer_verification_reviewers WHERE user_id=$1 FOR SHARE',
      [user],
    );
    if (r.rowCount !== 1)
      trainingError(403, 'REVIEWER_REQUIRED', 'Раздел доступен администратору.');
  }
  public async templates(trainer: string) {
    await this.training.trainer(this.training.pool, trainer);
    return {
      templates: (
        await this.training.pool.query(
          'SELECT id,title,goal,workouts FROM training_templates WHERE trainer_id=$1 ORDER BY created_at DESC',
          [trainer],
        )
      ).rows,
    };
  }
  public async saveTemplate(trainer: string, id: string) {
    return this.training.transaction(async (db) => {
      const p = await this.training.ownedPlan(db, trainer, id);
      const count = await db.query(
        'SELECT count(*)::int n FROM training_templates WHERE trainer_id=$1',
        [trainer],
      );
      if (count.rows[0].n >= 100)
        trainingError(409, 'TEMPLATE_LIMIT', 'Удалите ненужные шаблоны: лимит — 100.');
      const workouts = (await this.training.plans(db, p.student_id)).find(
        (v) => v.id === id,
      )!.workouts;
      const clean = workouts.map(
        ({ title, instructions, scheduled_date, duration_minutes, lesson_id, exercises }) => ({
          id: randomUUID(),
          title,
          instructions,
          scheduled_date,
          duration_minutes,
          lesson_id,
          exercises: exercises ?? [],
        }),
      );
      const inserted = await db.query(
        'INSERT INTO training_templates(trainer_id,title,goal,workouts) VALUES($1,$2,$3,$4::jsonb) RETURNING id',
        [trainer, p.title, p.goal, JSON.stringify(clean)],
      );
      return { id: inserted.rows[0].id as string };
    });
  }
  public async removeTemplate(trainer: string, id: string) {
    return this.training.transaction(async (db) => {
      await this.training.trainer(db, trainer);
      const r = await db.query(
        'DELETE FROM training_templates WHERE id=$1 AND trainer_id=$2 RETURNING id',
        [trainingId(id), trainer],
      );
      if (r.rowCount !== 1) trainingError(404, 'TEMPLATE_NOT_FOUND', 'Шаблон недоступен.');
      return { saved: true };
    });
  }
  public async assignTemplate(trainer: string, student: string, body: unknown) {
    if (
      !body ||
      typeof body !== 'object' ||
      !('template_id' in body) ||
      typeof body.template_id !== 'string'
    )
      trainingError(400, 'INVALID_TEMPLATE', 'Выберите шаблон.');
    const templateId = trainingId(body.template_id);
    const start = 'start_date' in body ? body.start_date : null;
    if (start !== null && !date.safeParse(start).success)
      trainingError(400, 'INVALID_DATE', 'Проверьте дату начала.');
    return this.training.transaction(async (db) => {
      await this.training.student(db, trainer, student);
      const r = await db.query(
        'SELECT * FROM training_templates WHERE id=$1 AND trainer_id=$2 FOR SHARE',
        [templateId, trainer],
      );
      if (!r.rows[0]) trainingError(404, 'TEMPLATE_NOT_FOUND', 'Шаблон недоступен.');
      const count = await db.query(
        'SELECT count(*)::int n FROM training_plans WHERE student_id=$1',
        [student],
      );
      if (count.rows[0].n >= 100)
        trainingError(409, 'PLAN_LIMIT', 'Достигнут лимит программ ученика.');
      const t = r.rows[0],
        workouts = t.workouts as TrainingWorkoutInput[];
      const first = workouts
        .map((w) => w.scheduled_date)
        .filter((v): v is string => !!v)
        .sort()[0];
      const shifted = workouts.map((w, i) => ({
        ...w,
        id: randomUUID(),
        exercises: (w.exercises ?? []).map((e) => ({ ...e, id: randomUUID() })),
        scheduled_date: start
          ? new Date(
              new Date(String(start) + 'T12:00:00Z').getTime() +
                (first && w.scheduled_date
                  ? new Date(w.scheduled_date + 'T12:00:00Z').getTime() -
                    new Date(first + 'T12:00:00Z').getTime()
                  : i * 86400000),
            )
              .toISOString()
              .slice(0, 10)
          : null,
      }));
      if (
        !planSchema.safeParse({ title: t.title, goal: t.goal, revision: 1, workouts: shifted })
          .success
      )
        trainingError(400, 'INVALID_TEMPLATE', 'Шаблон нужно обновить.');
      for (const w of shifted)
        for (const id of [w.lesson_id, ...w.exercises.map((e) => e.lesson_id)].filter(Boolean)) {
          const lesson = await db.query(
            "SELECT id FROM training_lessons WHERE id=$1 AND trainer_id=$2 AND status='ready' FOR SHARE",
            [id, trainer],
          );
          if (lesson.rowCount !== 1)
            trainingError(409, 'LESSON_UNAVAILABLE', 'Один из уроков шаблона недоступен.');
        }
      const created = await db.query(
        'INSERT INTO training_plans(student_id,title,goal)VALUES($1,$2,$3) RETURNING id',
        [student, t.title, t.goal],
      );
      const id = created.rows[0].id as string;
      for (const [position, w] of shifted.entries())
        await db.query(
          'INSERT INTO training_workouts(id,plan_id,title,instructions,scheduled_date,duration_minutes,lesson_id,position,exercises)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
          [
            w.id,
            id,
            w.title,
            w.instructions,
            w.scheduled_date,
            w.duration_minutes,
            w.lesson_id,
            position,
            JSON.stringify(w.exercises),
          ],
        );
      return { id };
    });
  }
  public async attention(trainer: string) {
    await this.training.trainer(this.training.pool, trainer);
    const rows = await this.training.pool.query(
      `SELECT s.id,s.name,s.client_id,s.reports_seen_at,s.invite_expires_at,
   (SELECT max(l.updated_at) FROM training_logs l JOIN training_workouts w ON w.id=l.workout_id JOIN training_plans p ON p.id=w.plan_id WHERE p.student_id=s.id AND l.completed_at IS NOT NULL) report_at,
   (SELECT count(*)::int FROM training_workouts w JOIN training_plans p ON p.id=w.plan_id LEFT JOIN training_logs l ON l.workout_id=w.id WHERE p.student_id=s.id AND p.status='published' AND w.scheduled_date<(now() AT TIME ZONE COALESCE(tz.name,'UTC'))::date AND l.completed_at IS NULL) overdue,
   (SELECT count(*)::int FROM training_workouts w JOIN training_plans p ON p.id=w.plan_id LEFT JOIN training_logs l ON l.workout_id=w.id WHERE p.student_id=s.id AND p.status='published' AND l.completed_at IS NULL) remaining,
   EXISTS(SELECT 1 FROM training_plans p WHERE p.student_id=s.id AND p.status='published') has_plan
   FROM training_students s LEFT JOIN users u ON u.id=s.client_id LEFT JOIN pg_timezone_names tz ON tz.name=u.timezone WHERE s.trainer_id=$1 AND s.archived_at IS NULL ORDER BY s.created_at DESC`,
      [trainer],
    );
    const events: TrainingAttention[] = [];
    for (const s of rows.rows) {
      const base = { student_id: s.id as string, name: s.name as string };
      if (!s.client_id)
        events.push({
          ...base,
          kind: 'invitation',
          title:
            !s.invite_expires_at || new Date(s.invite_expires_at).getTime() <= Date.now()
              ? 'Срок приглашения истёк — создайте новое'
              : new Date(s.invite_expires_at).getTime() <= Date.now() + 2 * 86400000
                ? 'Приглашение истекает в ближайшие 2 дня'
                : 'Ещё не принял приглашение',
        });
      if (s.report_at && (!s.reports_seen_at || s.report_at > s.reports_seen_at))
        events.push({ ...base, kind: 'report', title: 'Новый отчёт о тренировке' });
      if (s.overdue > 0)
        events.push({ ...base, kind: 'overdue', title: `Пропущено по расписанию: ${s.overdue}` });
      if (s.has_plan && s.remaining <= 1)
        events.push({
          ...base,
          kind: 'ending',
          title: s.remaining === 0 ? 'Программа выполнена' : 'Осталось одно занятие',
        });
    }
    const requests = await this.training.pool.query(
      `SELECT r.id,r.reason,to_char(r.requested_date,'YYYY-MM-DD') requested_date,s.id student_id,s.name,w.title FROM training_reschedules r JOIN training_workouts w ON w.id=r.workout_id JOIN training_plans p ON p.id=w.plan_id JOIN training_students s ON s.id=p.student_id WHERE s.trainer_id=$1 AND s.archived_at IS NULL AND p.status='published' AND r.status='pending'`,
      [trainer],
    );
    for (const r of requests.rows)
      events.unshift({
        student_id: r.student_id,
        name: r.name,
        kind: 'reschedule',
        title: `Перенос: ${r.title}`,
        request_id: r.id,
        requested_date: r.requested_date,
        reason: r.reason,
      });
    return { events };
  }
  public async seen(trainer: string, id: string) {
    return this.training.transaction(async (db) => {
      await this.training.student(db, trainer, id);
      await db.query('UPDATE training_students SET reports_seen_at=now() WHERE id=$1', [id]);
      return { saved: true };
    });
  }
  public async requestReschedule(client: string, id: string, body: unknown) {
    const v = rescheduleSchema.safeParse(body);
    if (!v.success) trainingError(400, 'INVALID_DATE', 'Выберите новую дату.');
    return this.training.transaction(async (db) => {
      const found = await db.query(
        `SELECT w.id FROM training_workouts w JOIN training_plans p ON p.id=w.plan_id JOIN training_students s ON s.id=p.student_id JOIN trainer_profiles t ON t.user_id=s.trainer_id LEFT JOIN training_logs l ON l.workout_id=w.id WHERE w.id=$1 AND s.client_id=$2 AND s.archived_at IS NULL AND t.is_active AND p.status='published' AND l.completed_at IS NULL FOR SHARE OF s,t,p FOR UPDATE OF w`,
        [trainingId(id), client],
      );
      if (found.rowCount !== 1) trainingError(404, 'WORKOUT_UNAVAILABLE', 'Перенос недоступен.');
      const r = await db.query(
        `INSERT INTO training_reschedules(workout_id,client_id,requested_date,reason)VALUES($1,$2,$3,$4) ON CONFLICT(workout_id) WHERE status='pending' DO UPDATE SET requested_date=$3,reason=$4 RETURNING id`,
        [id, client, v.data.requested_date, v.data.reason],
      );
      return { id: r.rows[0].id };
    });
  }
  public async reschedules(client: string) {
    return {
      requests: (
        await this.training.pool.query(
          "SELECT r.id,r.workout_id,r.status,r.reason,to_char(r.requested_date,'YYYY-MM-DD') requested_date FROM training_reschedules r WHERE r.client_id=$1 ORDER BY r.created_at DESC LIMIT 100",
          [client],
        )
      ).rows,
    };
  }
  public async reviewReschedule(trainer: string, id: string, body: unknown) {
    if (
      !body ||
      typeof body !== 'object' ||
      !('approve' in body) ||
      typeof body.approve !== 'boolean'
    )
      trainingError(400, 'INVALID_DECISION', 'Выберите решение.');
    return this.training.transaction(async (db) => {
      const f = await db.query(
        'SELECT w.plan_id FROM training_reschedules r JOIN training_workouts w ON w.id=r.workout_id WHERE r.id=$1',
        [trainingId(id)],
      );
      if (!f.rows[0]) trainingError(404, 'REQUEST_NOT_FOUND', 'Запрос недоступен.');
      const plan = await this.training.ownedPlan(db, trainer, f.rows[0].plan_id);
      const r = await db.query('SELECT * FROM training_reschedules WHERE id=$1 FOR UPDATE', [id]);
      if (r.rows[0].status !== 'pending' || plan.status !== 'published')
        trainingError(409, 'REQUEST_CHANGED', 'Запрос уже обработан или программа изменена.');
      if (body.approve) {
        const w = await db.query(
          'SELECT w.id FROM training_workouts w LEFT JOIN training_logs l ON l.workout_id=w.id WHERE w.id=$1 AND l.completed_at IS NULL AND COALESCE(jsonb_array_length(l.set_records),0)=0 FOR UPDATE OF w',
          [r.rows[0].workout_id],
        );
        if (w.rowCount !== 1)
          trainingError(409, 'WORKOUT_STARTED', 'Начатую тренировку перенести нельзя.');
        await db.query('UPDATE training_workouts SET scheduled_date=$2 WHERE id=$1', [
          r.rows[0].workout_id,
          r.rows[0].requested_date,
        ]);
        await db.query(
          'UPDATE training_plans SET revision=revision+1,updated_at=now() WHERE id=$1',
          [plan.id],
        );
      }
      await db.query('UPDATE training_reschedules SET status=$2,reviewed_at=now() WHERE id=$1', [
        id,
        body.approve ? 'approved' : 'rejected',
      ]);
      return { saved: true };
    });
  }
  public async measurements(user: string, student?: string) {
    if (student)
      return this.training.transaction(async (db) => {
        const active = await this.training.student(db, user, student);
        if (active.archived_at) trainingError(404, 'STUDENT_NOT_FOUND', 'Ученик недоступен.');
        return {
          measurements: (
            await db.query(
              `SELECT id,to_char(recorded_date,'YYYY-MM-DD') recorded_date,weight_kg::float8,waist_cm::float8,chest_cm::float8,hips_cm::float8,note,share_with_trainer,photo_id FROM training_measurements WHERE student_id=$1 AND share_with_trainer ORDER BY recorded_date DESC,created_at DESC LIMIT 365`,
              [student],
            )
          ).rows,
        };
      });
    return {
      measurements: (
        await this.training.pool.query(
          `SELECT id,to_char(recorded_date,'YYYY-MM-DD') recorded_date,weight_kg::float8,waist_cm::float8,chest_cm::float8,hips_cm::float8,note,share_with_trainer,photo_id FROM training_measurements WHERE client_id=$1 ORDER BY recorded_date DESC,created_at DESC LIMIT 365`,
          [user],
        )
      ).rows,
    };
  }
  public async addMeasurement(client: string, body: unknown) {
    const v = measurementSchema.safeParse(body);
    if (!v.success) trainingError(400, 'INVALID_MEASUREMENT', 'Проверьте дату и значения замеров.');
    return this.training.transaction(async (db) => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [client]);
      const n = await db.query(
        'SELECT count(*)::int n FROM training_measurements WHERE client_id=$1',
        [client],
      );
      if (n.rows[0].n >= 1000)
        trainingError(409, 'MEASUREMENT_LIMIT', 'Достигнут лимит записей. Удалите ненужные.');
      const student = await db.query(
        'SELECT s.id FROM training_students s JOIN trainer_profiles t ON t.user_id=s.trainer_id WHERE s.client_id=$1 AND s.archived_at IS NULL AND t.is_active FOR SHARE OF s,t',
        [client],
      );
      if (v.data.share_with_trainer && !student.rows[0])
        trainingError(409, 'TRAINER_REQUIRED', 'Сначала подключитесь к тренеру.');
      const d = v.data;
      const r = await db.query(
        'INSERT INTO training_measurements(client_id,student_id,recorded_date,weight_kg,waist_cm,chest_cm,hips_cm,note,share_with_trainer)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
        [
          client,
          student.rows[0]?.id ?? null,
          d.recorded_date,
          d.weight_kg,
          d.waist_cm,
          d.chest_cm,
          d.hips_cm,
          d.note,
          d.share_with_trainer,
        ],
      );
      return { id: r.rows[0].id as string };
    });
  }
  public async complaints(user: string, admin = false) {
    return this.training.transaction(async (db) => {
      if (admin) await this.reviewer(db, user);
      const r = await db.query(
        `SELECT c.*,t.display_name trainer_name,COALESCE(u.first_name,u.username,'Ученик') client_name,COALESCE((SELECT jsonb_agg(jsonb_build_object('status',e.status,'reason',e.reason,'created_at',e.created_at) ORDER BY e.created_at) FROM training_complaint_events e WHERE e.complaint_id=c.id),'[]'::jsonb) events FROM training_complaints c JOIN trainer_profiles t ON t.user_id=c.trainer_id JOIN users u ON u.id=c.client_id ${admin ? '' : 'WHERE c.client_id=$1'} ORDER BY c.created_at DESC LIMIT 200`,
        admin ? [] : [user],
      );
      return { complaints: r.rows };
    });
  }
  public async complain(user: string, body: unknown) {
    const v = complaintSchema.safeParse(body);
    if (!v.success)
      trainingError(400, 'INVALID_COMPLAINT', 'Опишите ситуацию: от 10 до 2000 символов.');
    return this.training.transaction(async (db) => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user]);
      const s = await db.query(
        'SELECT trainer_id FROM training_students WHERE client_id=$1 AND archived_at IS NULL FOR SHARE',
        [user],
      );
      if (!s.rows[0]) trainingError(404, 'TRAINER_NOT_FOUND', 'Нет подключённого тренера.');
      const count = await db.query(
        "SELECT count(*)::int n FROM training_complaints WHERE client_id=$1 AND created_at>now()-interval '1 day'",
        [user],
      );
      if (count.rows[0].n >= 3)
        trainingError(
          429,
          'COMPLAINT_LIMIT',
          'Обращение уже принято. Дождитесь ответа администратора.',
        );
      const r = await db.query(
        'INSERT INTO training_complaints(client_id,trainer_id,reason)VALUES($1,$2,$3) RETURNING id',
        [user, s.rows[0].trainer_id, v.data.reason],
      );
      await db.query(
        "INSERT INTO training_complaint_events(complaint_id,actor_user_id,status,reason)VALUES($1,$2,'new',$3)",
        [r.rows[0].id, user, v.data.reason],
      );
      return { id: r.rows[0].id };
    });
  }
  public async reviewComplaint(user: string, id: string, body: unknown) {
    const v = complaintReviewSchema.safeParse(body);
    if (!v.success) trainingError(400, 'INVALID_REVIEW', 'Укажите решение и комментарий.');
    return this.training.transaction(async (db) => {
      await this.reviewer(db, user);
      const r = await db.query('SELECT * FROM training_complaints WHERE id=$1 FOR UPDATE', [
        trainingId(id),
      ]);
      const c = r.rows[0];
      if (!c) trainingError(404, 'COMPLAINT_NOT_FOUND', 'Обращение недоступно.');
      if (c.client_id === user || c.trainer_id === user)
        trainingError(403, 'SELF_REVIEW_FORBIDDEN', 'Нельзя рассматривать обращение о себе.');
      if (c.revision !== v.data.revision || c.status === 'resolved')
        trainingError(409, 'COMPLAINT_CHANGED', 'Обращение уже изменено. Обновите список.');
      await db.query(
        'UPDATE training_complaints SET status=$2,resolution=$3,revision=revision+1,updated_at=now() WHERE id=$1',
        [id, v.data.status, v.data.resolution],
      );
      await db.query(
        'INSERT INTO training_complaint_events(complaint_id,actor_user_id,status,reason)VALUES($1,$2,$3,$4)',
        [id, user, v.data.status, v.data.resolution],
      );
      return { saved: true };
    });
  }
  public async verificationHistory(user: string, id: string) {
    return this.training.transaction(async (db) => {
      await this.reviewer(db, user);
      const r = await db.query(
        'SELECT from_status,to_status,reason,created_at FROM trainer_verification_events WHERE request_id=$1 ORDER BY created_at,id',
        [trainingId(id)],
      );
      return { events: r.rows };
    });
  }
}
