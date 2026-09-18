import { TrainingService } from '../training/service.js';
import type {
  CoachHistoryResponse,
  CoachMessage,
  TrainerClientContext,
  WorkoutGuide,
  WorkoutSessionResponse,
} from '@kinetra/shared';
import type { Pool } from 'pg';
import { HttpError } from '../auth/errors.js';
import type { ProgramService } from '../program/service.js';
import type { ProgressService } from '../progress/service.js';
import type { CoachProvider } from './provider.js';
import {
  coachQuestionSchema,
  workoutGuideSchema,
  workoutKeySchema,
  workoutSessionSchema,
} from './schema.js';

const emptyGuide: WorkoutGuide = { equipment: [], technique: '', chapters: [] };

export class CoachingService {
  public constructor(
    private readonly pool: Pool,
    private readonly program: Pick<ProgramService, 'getWeek' | 'getCurrentWeek'>,
    private readonly progress: Pick<ProgressService, 'getProgress'>,
    private readonly provider: CoachProvider | null,
  ) {}

  private async workout(userId: string, videoId: unknown, programWeek: unknown) {
    const parsed = workoutKeySchema.safeParse({ video_id: videoId, program_week: programWeek });
    if (!parsed.success) throw new HttpError(400, 'INVALID_WORKOUT', 'Некорректная тренировка.');
    const user = await this.pool.query('SELECT onboarding_status FROM users WHERE id=$1', [userId]);
    if (user.rows[0]?.onboarding_status !== 'active')
      throw new HttpError(403, 'BASE_LESSONS_REQUIRED', 'Сначала завершите подготовку.');
    const week = await this.program.getWeek(userId, parsed.data.program_week);
    const day = week.week.days.find((item) => item.video.id === parsed.data.video_id);
    if (day === undefined || week.week.status === 'locked')
      throw new HttpError(403, 'WORKOUT_UNAVAILABLE', 'Эта тренировка пока недоступна.');
    return { ...parsed.data, day };
  }

  public async getSession(
    userId: string,
    videoId: unknown,
    week: unknown,
  ): Promise<WorkoutSessionResponse> {
    const key = await this.workout(userId, videoId, week);
    const [session, guide] = await Promise.all([
      this.pool.query(
        'SELECT position_seconds, difficulty, wellbeing, note FROM workout_sessions WHERE user_id=$1 AND video_id=$2 AND program_week=$3',
        [userId, key.video_id, key.program_week],
      ),
      this.pool.query(
        'SELECT equipment, technique, chapters FROM workout_guides WHERE video_id=$1',
        [key.video_id],
      ),
    ]);
    return {
      position_seconds: 0,
      difficulty: null,
      wellbeing: null,
      note: '',
      ...session.rows[0],
      guide: (guide.rows[0] as WorkoutGuide | undefined) ?? emptyGuide,
    };
  }

  public async saveSession(
    userId: string,
    videoId: unknown,
    week: unknown,
    body: unknown,
  ): Promise<void> {
    const parsed = workoutSessionSchema.safeParse(body);
    if (!parsed.success)
      throw new HttpError(400, 'INVALID_WORKOUT_FEEDBACK', 'Проверьте отметки тренировки.');
    const key = await this.workout(userId, videoId, week);
    const value = parsed.data;
    if (
      (value.difficulty !== undefined ||
        value.wellbeing !== undefined ||
        value.note !== undefined) &&
      !key.day.completed
    )
      throw new HttpError(409, 'WORKOUT_NOT_COMPLETED', 'Сначала завершите тренировку.');
    await this.pool.query(
      `INSERT INTO workout_sessions(user_id,video_id,program_week,position_seconds,difficulty,wellbeing,note)
      VALUES($1,$2,$3,COALESCE($4,0),$5,$6,COALESCE($7,''))
      ON CONFLICT(user_id,video_id,program_week) DO UPDATE SET
      position_seconds=COALESCE($4,workout_sessions.position_seconds), difficulty=COALESCE($5,workout_sessions.difficulty),
      wellbeing=COALESCE($6,workout_sessions.wellbeing), note=COALESCE($7,workout_sessions.note), updated_at=now()`,
      [
        userId,
        key.video_id,
        key.program_week,
        value.position_seconds ?? null,
        value.difficulty ?? null,
        value.wellbeing ?? null,
        value.note ?? null,
      ],
    );
  }

  public async getGuide(trainerId: string, videoId: string): Promise<WorkoutGuide> {
    await this.requireVideoManager(trainerId, videoId);
    const result = await this.pool.query(
      'SELECT equipment, technique, chapters FROM workout_guides WHERE video_id=$1',
      [videoId],
    );
    return (result.rows[0] as WorkoutGuide | undefined) ?? emptyGuide;
  }

  public async saveGuide(trainerId: string, videoId: string, body: unknown): Promise<WorkoutGuide> {
    await this.requireVideoManager(trainerId, videoId);
    const parsed = workoutGuideSchema.safeParse(body);
    if (!parsed.success)
      throw new HttpError(
        400,
        'INVALID_WORKOUT_GUIDE',
        'Проверьте разделы: время должно возрастать, названия не должны быть пустыми.',
      );
    const guide = parsed.data;
    const video = await this.pool.query('SELECT duration_seconds FROM videos WHERE id=$1', [
      videoId,
    ]);
    const duration = Number(video.rows[0]?.duration_seconds ?? 0);
    if (guide.chapters.some((chapter) => chapter.start_seconds >= duration)) {
      throw new HttpError(
        400,
        'INVALID_WORKOUT_GUIDE',
        'Раздел не может начинаться после окончания видео.',
      );
    }
    await this.pool.query(
      `INSERT INTO workout_guides(video_id,equipment,technique,chapters,updated_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(video_id) DO UPDATE SET equipment=$2,technique=$3,chapters=$4,updated_by=$5,updated_at=now()`,
      [
        videoId,
        JSON.stringify(guide.equipment),
        guide.technique,
        JSON.stringify(guide.chapters),
        trainerId,
      ],
    );
    return guide;
  }

  private async requireVideoManager(userId: string, videoId: string): Promise<void> {
    if (!workoutKeySchema.shape.video_id.safeParse(videoId).success)
      throw new HttpError(400, 'INVALID_VIDEO', 'Некорректное видео.');
    const result = await this.pool.query(
      'SELECT 1 FROM trainer_profiles t JOIN users u ON u.id=t.user_id CROSS JOIN videos v WHERE t.user_id=$1 AND t.is_active=true AND t.can_manage_videos=true AND v.id=$2',
      [userId, videoId],
    );
    if (result.rowCount !== 1)
      throw new HttpError(
        403,
        'TRAINER_VIDEO_ACCESS_REQUIRED',
        'Нет доступа к материалам тренировки.',
      );
  }

  public async clientContext(
    trainerId: string,
    conversationId: string,
  ): Promise<TrainerClientContext> {
    if (!workoutKeySchema.shape.video_id.safeParse(conversationId).success)
      throw new HttpError(400, 'INVALID_CONVERSATION', 'Некорректный диалог.');
    const result = await this.pool.query(
      `SELECT c.client_user_id FROM chat_conversations c JOIN trainer_profiles t ON t.user_id=c.trainer_user_id JOIN users u ON u.id=c.client_user_id
      WHERE c.id=$1 AND c.trainer_user_id=$2 AND t.is_active=true`,
      [conversationId, trainerId],
    );
    const clientId = result.rows[0]?.client_user_id as string | undefined;
    if (clientId === undefined)
      throw new HttpError(403, 'CONVERSATION_ACCESS_REQUIRED', 'Этот клиент вам не назначен.');
    const personal = await this.pool.query(
      'SELECT id,archived_at FROM training_students WHERE client_id=$1 AND trainer_id=$2 ORDER BY (archived_at IS NULL) DESC,created_at DESC LIMIT 1',
      [clientId, trainerId],
    );
    if (personal.rows[0]?.archived_at)
      throw new HttpError(
        403,
        'CONVERSATION_ACCESS_REQUIRED',
        'Ученик в архиве. История доступна в кабинете.',
      );
    const personalTraining = personal.rows[0]
      ? await new TrainingService(this.pool, false).detail(trainerId, personal.rows[0].id)
      : undefined;
    const [progress, sessions] = personalTraining
      ? [null, { rows: [] }]
      : await Promise.all([
          this.progress.getProgress(clientId),
          this.pool.query(
            'SELECT v.title,s.program_week,s.difficulty,s.wellbeing,s.note,s.updated_at FROM workout_sessions s JOIN videos v ON v.id=s.video_id WHERE s.user_id=$1 AND s.difficulty IS NOT NULL ORDER BY s.updated_at DESC LIMIT 5',
            [clientId],
          ),
        ]);
    // Re-check assignment after asynchronous reads, so a reassigned conversation cannot return new data.
    const stillAssigned = await this.pool.query(
      `SELECT 1 FROM chat_conversations c JOIN trainer_profiles t ON t.user_id=c.trainer_user_id WHERE c.id=$1 AND c.trainer_user_id=$2 AND t.is_active=true AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM training_students s WHERE s.id=$3 AND s.archived_at IS NULL AND s.trainer_id=$2 AND s.client_id=c.client_user_id))`,
      [conversationId, trainerId, personal.rows[0]?.id ?? null],
    );
    if (stillAssigned.rowCount !== 1)
      throw new HttpError(403, 'CONVERSATION_ACCESS_REQUIRED', 'Назначение клиента изменилось.');
    if (personalTraining)
      return { personal_training: personalTraining, progress: null, recent_sessions: [] };
    return {
      progress: progress!,
      recent_sessions: sessions.rows as TrainerClientContext['recent_sessions'],
    };
  }

  public async history(userId: string): Promise<CoachHistoryResponse> {
    const result = await this.pool.query(
      "SELECT id, question, answer, created_at FROM coach_messages WHERE user_id=$1 AND status='completed' ORDER BY created_at DESC LIMIT 20",
      [userId],
    );
    return { available: this.provider !== null, messages: result.rows.reverse() as CoachMessage[] };
  }

  public async ask(userId: string, body: unknown): Promise<CoachMessage> {
    const parsed = coachQuestionSchema.safeParse(body);
    if (!parsed.success)
      throw new HttpError(
        400,
        'INVALID_COACH_QUESTION',
        'Вопрос должен содержать от 1 до 2000 символов.',
      );
    if (this.provider === null)
      throw new HttpError(
        503,
        'COACH_NOT_CONFIGURED',
        'ИИ-помощник ещё не подключён. Вы можете написать тренеру.',
      );
    const { request_id: id, question, use_progress: useProgress } = parsed.data;
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SELECT pg_advisory_xact_lock(hashtext('kinetra-coach-quota'))");
      const previous = await connection.query('SELECT * FROM coach_messages WHERE id=$1', [id]);
      const old = previous.rows[0];
      if (old !== undefined) {
        if (old.user_id !== userId || old.question !== question || old.use_progress !== useProgress)
          throw new HttpError(409, 'COACH_REQUEST_CONFLICT', 'Создайте новый вопрос.');
        if (old.status === 'completed') {
          await connection.query('COMMIT');
          return old as CoachMessage;
        }
        if (old.status === 'pending' && Date.now() - new Date(old.created_at).getTime() < 60_000)
          throw new HttpError(409, 'COACH_REQUEST_PENDING', 'Ответ ещё готовится.');
      }
      const pending = await connection.query(
        "SELECT 1 FROM coach_messages WHERE user_id=$1 AND status='pending' AND created_at>now()-interval '60 seconds' LIMIT 1",
        [userId],
      );
      if (pending.rowCount !== 0)
        throw new HttpError(429, 'COACH_BUSY', 'Дождитесь ответа на предыдущий вопрос.');
      const total = await connection.query(
        "SELECT COALESCE(sum(requests),0)::integer AS count FROM coach_daily_usage WHERE usage_day=(now() AT TIME ZONE 'UTC')::date",
      );
      if (Number(total.rows[0]?.count) >= 200)
        throw new HttpError(
          429,
          'COACH_DAILY_LIMIT',
          'Сегодня помощник достиг лимита. Напишите тренеру.',
        );
      const quota = await connection.query(
        `INSERT INTO coach_daily_usage(user_id,usage_day,requests) VALUES($1,(now() AT TIME ZONE 'UTC')::date,1)
        ON CONFLICT(user_id,usage_day) DO UPDATE SET requests=coach_daily_usage.requests+1 WHERE coach_daily_usage.requests<20 RETURNING requests`,
        [userId],
      );
      if (quota.rowCount !== 1)
        throw new HttpError(
          429,
          'COACH_DAILY_LIMIT',
          'На сегодня доступно до 20 вопросов. Продолжите завтра или напишите тренеру.',
        );
      await connection.query(
        "INSERT INTO coach_messages(id,user_id,question,use_progress,status) VALUES($1,$2,$3,$4,'pending') ON CONFLICT(id) DO UPDATE SET status='pending',created_at=now()",
        [id, userId, question, useProgress],
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    try {
      const progress = await this.progress.getProgress(userId);
      const week = await this.program.getCurrentWeek(userId).catch((error: unknown) => {
        if (error instanceof HttpError && error.statusCode === 403) return null;
        throw error;
      });
      const context = JSON.stringify({
        program: { weeks: 12, base_lessons: 7, unlock_after: 4 },
        current_week: week?.week.week_number ?? progress.metrics.current_week,
        workouts:
          week?.week.days.map((day) => ({
            title: day.title,
            description: day.description,
            duration_minutes: day.duration_minutes,
            ...(useProgress ? { completed: day.completed } : {}),
          })) ?? [],
        ...(useProgress
          ? {
              activity: progress.stats,
              weekly_marks: progress.metrics.history
                .slice(-4)
                .map(({ program_week, energy, sleep, mood, body_satisfaction }) => ({
                  program_week,
                  energy,
                  sleep,
                  mood,
                  body_satisfaction,
                })),
            }
          : {}),
      });
      const answer = await this.provider.answer(question, context);
      const result = await this.pool.query(
        "UPDATE coach_messages SET status='completed',answer=$3 WHERE id=$1 AND user_id=$2 RETURNING id,question,answer,created_at",
        [id, userId, answer],
      );
      return result.rows[0] as CoachMessage;
    } catch (error) {
      await this.pool.query(
        "UPDATE coach_messages SET status='failed' WHERE id=$1 AND user_id=$2 AND status='pending'",
        [id, userId],
      );
      throw error;
    }
  }
}
