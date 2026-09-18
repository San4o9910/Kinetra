import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  MyTraining,
  TrainingPlan,
  TrainingStudentDetail,
  TrainingLibrary,
} from '@kinetra/shared';
import { HttpError } from '../auth/errors.js';
import {
  inviteSchema,
  lessonSchema,
  logSchema,
  planSchema,
  studentSchema,
  uuid,
} from './schema.js';

export function trainingError(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}
export const trainingId = (value: string): string =>
  uuid.safeParse(value).success ? value : trainingError(400, 'INVALID_ID', 'Некорректный адрес.');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const studentsSql = `SELECT s.*,c.id AS conversation_id,
  (SELECT count(*)::integer FROM training_workouts w JOIN training_plans p ON p.id=w.plan_id WHERE p.student_id=s.id AND p.status='published') AS total,
  (SELECT count(*)::integer FROM training_logs l JOIN training_workouts w ON w.id=l.workout_id JOIN training_plans p ON p.id=w.plan_id WHERE p.student_id=s.id AND p.status='published' AND l.completed_at IS NOT NULL) AS completed,
  (SELECT COALESCE(sum(w.duration_minutes),0)::integer FROM training_logs l JOIN training_workouts w ON w.id=l.workout_id JOIN training_plans p ON p.id=w.plan_id WHERE p.student_id=s.id AND l.completed_at IS NOT NULL) AS minutes,
  (SELECT max(l.completed_at) FROM training_logs l JOIN training_workouts w ON w.id=l.workout_id JOIN training_plans p ON p.id=w.plan_id WHERE p.student_id=s.id) AS last_completed_at
  FROM training_students s JOIN trainer_profiles t ON t.user_id=s.trainer_id AND t.is_active=true
  LEFT JOIN chat_conversations c ON c.client_user_id=s.client_id AND c.trainer_user_id=s.trainer_id`;

export class TrainingService {
  public constructor(
    public readonly pool: Pool,
    public readonly mediaAvailable: boolean,
  ) {}
  public async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const value = await fn(db);
      await db.query('COMMIT');
      return value;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  public async trainer(db: Pool | PoolClient, id: string): Promise<void> {
    const result = await db.query(
      'SELECT user_id FROM trainer_profiles WHERE user_id=$1 AND is_active=true FOR SHARE',
      [id],
    );
    if (result.rowCount !== 1)
      trainingError(403, 'TRAINER_REQUIRED', 'Кабинет доступен после одобрения заявки тренера.');
  }
  private async student(db: PoolClient, trainer: string, id: string, active = true) {
    await this.trainer(db, trainer);
    const result = await db.query(
      'SELECT * FROM training_students WHERE id=$1 AND trainer_id=$2 FOR UPDATE',
      [trainingId(id), trainer],
    );
    const row = result.rows[0];
    if (!row || (active && row.archived_at))
      trainingError(404, 'STUDENT_NOT_FOUND', 'Ученик недоступен.');
    return row;
  }
  public async listStudents(trainer: string) {
    await this.trainer(this.pool, trainer);
    const result = await this.pool.query(
      `${studentsSql} WHERE s.trainer_id=$1 ORDER BY s.created_at DESC`,
      [trainer],
    );
    // Invite hashes are never returned to clients.
    return {
      students: result.rows.map(
        ({ invite_hash: _hash, invite_expires_at: _expires, ...row }) => row,
      ),
    };
  }
  public async createStudent(trainer: string, body: unknown) {
    const parsed = studentSchema.safeParse(body);
    if (!parsed.success)
      trainingError(400, 'INVALID_STUDENT', 'Укажите имя ученика (до 120 символов).');
    return this.transaction(async (db) => {
      await this.trainer(db, trainer);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('training-students'),hashtext($1))", [
        trainer,
      ]);
      const count = await db.query(
        'SELECT count(*)::integer n FROM training_students WHERE trainer_id=$1 AND archived_at IS NULL',
        [trainer],
      );
      if (count.rows[0].n >= 500)
        trainingError(409, 'STUDENT_LIMIT', 'Достигнут лимит активных учеников.');
      const token = randomBytes(32).toString('base64url');
      const result = await db.query(
        `INSERT INTO training_students(trainer_id,name,contact,invite_hash,invite_expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days') RETURNING id`,
        [trainer, parsed.data.name, parsed.data.contact, hash(token)],
      );
      return { id: result.rows[0].id as string, token };
    });
  }
  public async renewInvite(trainer: string, id: string) {
    return this.transaction(async (db) => {
      const student = await this.student(db, trainer, id);
      if (student.client_id) trainingError(409, 'ALREADY_CONNECTED', 'Ученик уже подключён.');
      const token = randomBytes(32).toString('base64url');
      await db.query(
        "UPDATE training_students SET invite_hash=$2,invite_expires_at=now()+interval '7 days' WHERE id=$1",
        [id, hash(token)],
      );
      return { token };
    });
  }
  public async invitation(body: unknown) {
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) trainingError(400, 'INVALID_INVITE', 'Проверьте ссылку приглашения.');
    const result = await this.pool.query(
      `SELECT t.display_name FROM training_students s JOIN trainer_profiles t ON t.user_id=s.trainer_id WHERE s.invite_hash=$1 AND s.invite_expires_at>now() AND s.archived_at IS NULL AND s.client_id IS NULL AND t.is_active=true`,
      [hash(parsed.data.token)],
    );
    if (!result.rows[0])
      trainingError(
        404,
        'INVITE_EXPIRED',
        'Приглашение недоступно. Попросите тренера создать новую ссылку.',
      );
    return { trainer_name: result.rows[0].display_name as string };
  }
  public async acceptInvite(client: string, body: unknown) {
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) trainingError(400, 'INVALID_INVITE', 'Проверьте ссылку приглашения.');
    return this.transaction(async (db) => {
      // Serialize joining with chat assignment and other invitations for this user.
      const users = await db.query('SELECT id,requested_role FROM users WHERE id=$1 FOR UPDATE', [
        client,
      ]);
      if (users.rows[0]?.requested_role !== 'trainee')
        trainingError(403, 'CLIENT_REQUIRED', 'Приглашение предназначено для аккаунта ученика.');
      const result = await db.query(
        `SELECT s.* FROM training_students s JOIN trainer_profiles t ON t.user_id=s.trainer_id WHERE s.invite_hash=$1 AND s.invite_expires_at>now() AND s.archived_at IS NULL AND s.client_id IS NULL AND t.is_active=true FOR UPDATE OF s FOR SHARE OF t`,
        [hash(parsed.data.token)],
      );
      const student = result.rows[0];
      if (!student || student.trainer_id === client)
        trainingError(404, 'INVITE_EXPIRED', 'Приглашение недоступно. Попросите новую ссылку.');
      const connected = await db.query(
        'SELECT id FROM training_students WHERE client_id=$1 AND archived_at IS NULL',
        [client],
      );
      if (connected.rowCount !== 0)
        trainingError(409, 'ALREADY_CONNECTED', 'Вы уже подключены к тренеру.');
      const conversation = await db.query(
        'SELECT trainer_user_id FROM chat_conversations WHERE client_user_id=$1 FOR UPDATE',
        [client],
      );
      if (conversation.rows[0] && conversation.rows[0].trainer_user_id !== student.trainer_id)
        trainingError(
          409,
          'OTHER_TRAINER',
          'У вас уже есть диалог с другим тренером. Свяжитесь с поддержкой для переноса.',
        );
      await db.query(
        'INSERT INTO chat_conversations(client_user_id,trainer_user_id) VALUES($1,$2) ON CONFLICT(client_user_id) DO NOTHING',
        [client, student.trainer_id],
      );
      await db.query(
        'UPDATE training_students SET client_id=$2,accepted_at=now(),invite_hash=NULL,invite_expires_at=NULL WHERE id=$1',
        [student.id, client],
      );
      return { connected: true };
    });
  }
  public async archiveStudent(trainer: string, id: string) {
    await this.transaction(async (db) => {
      await this.student(db, trainer, id);
      await db.query(
        'UPDATE training_students SET archived_at=now(),invite_hash=NULL WHERE id=$1',
        [id],
      );
    });
    return { saved: true };
  }
  private async plans(
    db: Pool | PoolClient,
    studentId: string,
    client = false,
  ): Promise<TrainingPlan[]> {
    const result = await db.query(
      `SELECT id,title,goal,status,revision FROM training_plans WHERE student_id=$1 ${client ? "AND status<>'draft'" : ''} ORDER BY created_at DESC`,
      [studentId],
    );
    const workouts = await db.query(
      `SELECT w.*,v.title AS lesson_title,l.completed_at,COALESCE(l.position_seconds,0) AS position_seconds,l.difficulty,l.wellbeing,COALESCE(l.note,'') AS note,to_char(w.scheduled_date,'YYYY-MM-DD') AS scheduled_date
      FROM training_workouts w JOIN training_plans p ON p.id=w.plan_id LEFT JOIN training_lessons v ON v.id=w.lesson_id LEFT JOIN training_logs l ON l.workout_id=w.id
      WHERE p.student_id=$1 ${client ? "AND p.status<>'draft'" : ''} ORDER BY w.position`,
      [studentId],
    );
    return result.rows.map((p) => ({
      ...p,
      workouts: workouts.rows.filter((w) => w.plan_id === p.id),
    })) as TrainingPlan[];
  }
  public async detail(trainer: string, id: string): Promise<TrainingStudentDetail> {
    return this.transaction(async (db) => {
      await this.student(db, trainer, id, false);
      const result = await db.query(`${studentsSql} WHERE s.id=$1 AND s.trainer_id=$2`, [
        id,
        trainer,
      ]);
      const { invite_hash: _hash, invite_expires_at: _expires, ...student } = result.rows[0];
      return { student, plans: await this.plans(db, id) } as TrainingStudentDetail;
    });
  }
  public async myTraining(client: string): Promise<MyTraining> {
    return this.transaction(async (db) => {
      const result = await db.query(
        'SELECT s.id,t.display_name FROM training_students s JOIN trainer_profiles t ON t.user_id=s.trainer_id WHERE s.client_id=$1 AND s.archived_at IS NULL AND t.is_active=true FOR SHARE OF s,t',
        [client],
      );
      const row = result.rows[0];
      return {
        student_id: row?.id ?? null,
        trainer_name: row?.display_name ?? null,
        plans: row ? await this.plans(db, row.id, true) : [],
      };
    });
  }
  public async createPlan(trainer: string, student: string) {
    return this.transaction(async (db) => {
      await this.student(db, trainer, student);
      const count = await db.query(
        'SELECT count(*)::integer n FROM training_plans WHERE student_id=$1',
        [student],
      );
      if (count.rows[0].n >= 100)
        trainingError(409, 'PLAN_LIMIT', 'Достигнут лимит программ ученика.');
      const result = await db.query(
        "INSERT INTO training_plans(student_id,title) VALUES($1,'Новая программа') RETURNING id",
        [student],
      );
      return { id: result.rows[0].id as string };
    });
  }
  private async ownedPlan(db: PoolClient, trainer: string, id: string) {
    const found = await db.query('SELECT student_id FROM training_plans WHERE id=$1', [
      trainingId(id),
    ]);
    if (!found.rows[0]) trainingError(404, 'PLAN_NOT_FOUND', 'Программа недоступна.');
    await this.student(db, trainer, found.rows[0].student_id);
    const result = await db.query('SELECT * FROM training_plans WHERE id=$1 FOR UPDATE', [id]);
    return result.rows[0];
  }
  public async savePlan(trainer: string, id: string, body: unknown) {
    const parsed = planSchema.safeParse(body);
    if (!parsed.success)
      trainingError(400, 'INVALID_PLAN', 'Проверьте название, даты и заполнение занятий.');
    return this.transaction(async (db) => {
      const plan = await this.ownedPlan(db, trainer, id);
      if (plan.status === 'archived')
        trainingError(409, 'PLAN_ARCHIVED', 'Программа в архиве. Создайте новую.');
      if (plan.revision !== parsed.data.revision)
        trainingError(
          409,
          'PLAN_CHANGED',
          'Программа уже изменена. Обновите страницу перед сохранением.',
        );
      if (plan.status === 'published' && parsed.data.workouts.length === 0)
        trainingError(
          400,
          'EMPTY_PLAN',
          'В опубликованной программе должно остаться хотя бы одно занятие.',
        );
      const old = await db.query(
        'SELECT w.*,l.completed_at FROM training_workouts w LEFT JOIN training_logs l ON l.workout_id=w.id WHERE w.plan_id=$1',
        [id],
      );
      for (const w of old.rows.filter((w) => w.completed_at)) {
        const incoming = parsed.data.workouts.find((i) => i.id === w.id);
        if (
          !incoming ||
          incoming.title !== w.title ||
          incoming.instructions !== w.instructions ||
          incoming.lesson_id !== w.lesson_id ||
          incoming.duration_minutes !== w.duration_minutes ||
          incoming.scheduled_date !==
            (w.scheduled_date ? new Date(w.scheduled_date).toISOString().slice(0, 10) : null)
        )
          trainingError(
            409,
            'COMPLETED_WORKOUT',
            'Выполненное занятие нельзя изменить или удалить: оно хранит историю ученика.',
          );
      }
      for (const [position, w] of parsed.data.workouts.entries()) {
        if (w.lesson_id) {
          const lesson = await db.query(
            "SELECT id FROM training_lessons WHERE id=$1 AND trainer_id=$2 AND status='ready' FOR SHARE",
            [w.lesson_id, trainer],
          );
          if (lesson.rowCount !== 1)
            trainingError(400, 'LESSON_UNAVAILABLE', 'Выберите готовый урок из своей библиотеки.');
        }
        const result = await db.query(
          `INSERT INTO training_workouts(id,plan_id,title,instructions,scheduled_date,duration_minutes,lesson_id,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(id) DO UPDATE SET title=$3,instructions=$4,scheduled_date=$5,duration_minutes=$6,lesson_id=$7,position=$8 WHERE training_workouts.plan_id=$2 RETURNING id`,
          [
            w.id,
            id,
            w.title,
            w.instructions,
            w.scheduled_date,
            w.duration_minutes,
            w.lesson_id,
            position,
          ],
        );
        if (result.rowCount !== 1)
          trainingError(409, 'WORKOUT_CONFLICT', 'Создайте новое занятие в этой программе.');
      }
      await db.query('DELETE FROM training_workouts WHERE plan_id=$1 AND NOT(id=ANY($2::uuid[]))', [
        id,
        parsed.data.workouts.map((w) => w.id),
      ]);
      await db.query(
        'UPDATE training_plans SET title=$2,goal=$3,revision=revision+1,updated_at=now() WHERE id=$1',
        [id, parsed.data.title, parsed.data.goal],
      );
      return { saved: true, revision: (plan.revision + 1) as number };
    });
  }
  public async publishPlan(trainer: string, id: string, body: unknown) {
    const revision =
      typeof body === 'object' && body !== null && 'revision' in body ? body.revision : null;
    return this.transaction(async (db) => {
      const plan = await this.ownedPlan(db, trainer, id);
      if (plan.revision !== revision || plan.status !== 'draft')
        trainingError(409, 'PLAN_CHANGED', 'Обновите программу перед публикацией.');
      const count = await db.query(
        'SELECT count(*)::integer n FROM training_workouts WHERE plan_id=$1',
        [id],
      );
      if (count.rows[0].n === 0) trainingError(400, 'EMPTY_PLAN', 'Добавьте хотя бы одно занятие.');
      await db.query(
        "UPDATE training_plans SET status='archived',revision=revision+1 WHERE student_id=$1 AND status='published'",
        [plan.student_id],
      );
      await db.query(
        "UPDATE training_plans SET status='published',revision=revision+1,updated_at=now() WHERE id=$1",
        [id],
      );
      return { saved: true };
    });
  }
  public async log(client: string, id: string, body: unknown) {
    const parsed = logSchema.safeParse(body);
    if (!parsed.success) trainingError(400, 'INVALID_LOG', 'Проверьте отметку выполнения.');
    return this.transaction(async (db) => {
      const result = await db.query(
        `SELECT w.id FROM training_workouts w JOIN training_plans p ON p.id=w.plan_id JOIN training_students s ON s.id=p.student_id JOIN trainer_profiles t ON t.user_id=s.trainer_id
        WHERE w.id=$1 AND s.client_id=$2 AND s.archived_at IS NULL AND t.is_active=true AND p.status='published' FOR SHARE OF s,t,p FOR UPDATE OF w`,
        [trainingId(id), client],
      );
      if (result.rowCount !== 1) trainingError(404, 'WORKOUT_UNAVAILABLE', 'Занятие недоступно.');
      const v = parsed.data;
      await db.query(
        `INSERT INTO training_logs(workout_id,client_id,completed_at,position_seconds,difficulty,wellbeing,note) VALUES($1,$2,CASE WHEN $3 THEN now() END,COALESCE($4,0),$5,$6,COALESCE($7,''))
        ON CONFLICT(workout_id) DO UPDATE SET completed_at=COALESCE(training_logs.completed_at,EXCLUDED.completed_at),position_seconds=COALESCE($4,training_logs.position_seconds),difficulty=COALESCE($5,training_logs.difficulty),wellbeing=COALESCE($6,training_logs.wellbeing),note=COALESCE($7,training_logs.note),updated_at=now()`,
        [
          id,
          client,
          v.completed ?? false,
          v.position_seconds ?? null,
          v.difficulty ?? null,
          v.wellbeing ?? null,
          v.note ?? null,
        ],
      );
      return { saved: true };
    });
  }
  public async library(trainer: string): Promise<TrainingLibrary> {
    await this.trainer(this.pool, trainer);
    const result = await this.pool.query(
      "SELECT id,title,description,status,size_bytes::float8 AS size_bytes,duration_seconds FROM training_lessons WHERE trainer_id=$1 AND status<>'archived' ORDER BY created_at DESC",
      [trainer],
    );
    return {
      lessons: result.rows,
      upload_available: this.mediaAvailable,
      max_bytes: 256 * 1024 * 1024,
    };
  }
  public async createLesson(trainer: string, body: unknown) {
    if (!this.mediaAvailable)
      trainingError(503, 'MEDIA_UNAVAILABLE', 'Загрузка видео временно недоступна.');
    const parsed = lessonSchema.safeParse(body);
    if (!parsed.success)
      trainingError(400, 'INVALID_LESSON', 'Укажите название и видео размером до 256 МБ.');
    return this.transaction(async (db) => {
      await this.trainer(db, trainer);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('training-media-quota'))");
      const sum = await db.query(
        "SELECT COALESCE(sum(size_bytes),0)::float8 AS total,COALESCE(sum(size_bytes) FILTER(WHERE trainer_id=$1),0)::float8 AS own FROM training_lessons WHERE status IN ('pending','uploading','ready')",
        [trainer],
      );
      if (
        sum.rows[0].total + parsed.data.size_bytes > 5 * 1024 ** 3 ||
        sum.rows[0].own + parsed.data.size_bytes > 1024 ** 3
      )
        trainingError(409, 'MEDIA_QUOTA', 'Недостаточно места для урока. Удалите ненужные видео.');
      const id = randomUUID();
      await db.query(
        'INSERT INTO training_lessons(id,trainer_id,title,description,size_bytes) VALUES($1,$2,$3,$4,$5)',
        [id, trainer, parsed.data.title, parsed.data.description, parsed.data.size_bytes],
      );
      return { id };
    });
  }
  public async removeLesson(trainer: string, id: string) {
    return this.transaction(async (db) => {
      await this.trainer(db, trainer);
      const result = await db.query(
        'SELECT status FROM training_lessons WHERE id=$1 AND trainer_id=$2 FOR UPDATE',
        [trainingId(id), trainer],
      );
      if (!result.rows[0]) trainingError(404, 'LESSON_UNAVAILABLE', 'Урок недоступен.');
      if (result.rows[0].status === 'uploading')
        trainingError(409, 'UPLOAD_BUSY', 'Дождитесь завершения загрузки.');
      const used = await db.query('SELECT id FROM training_workouts WHERE lesson_id=$1 LIMIT 1', [
        id,
      ]);
      if (used.rowCount !== 0)
        trainingError(
          409,
          'LESSON_IN_USE',
          'Урок используется в программе. Сначала уберите его из невыполненных занятий.',
        );
      await db.query("UPDATE training_lessons SET status='archived',updated_at=now() WHERE id=$1", [
        id,
      ]);
      return { saved: true };
    });
  }
  public async mediaAccess(user: string, id: string) {
    const result = await this.pool.query(
      `SELECT l.id,l.size_bytes::float8 AS size_bytes FROM training_lessons l JOIN trainer_profiles t ON t.user_id=l.trainer_id WHERE l.id=$1 AND l.status='ready' AND t.is_active=true AND (l.trainer_id=$2 OR EXISTS(
      SELECT 1 FROM training_workouts w JOIN training_plans p ON p.id=w.plan_id JOIN training_students s ON s.id=p.student_id WHERE w.lesson_id=l.id AND p.status IN ('published','archived') AND s.client_id=$2 AND s.trainer_id=l.trainer_id AND s.archived_at IS NULL))`,
      [trainingId(id), user],
    );
    if (!result.rows[0]) trainingError(404, 'LESSON_UNAVAILABLE', 'Урок недоступен.');
    return result.rows[0] as { id: string; size_bytes: number };
  }
}
