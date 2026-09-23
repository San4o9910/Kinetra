import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import type { ProgressResponse, WeekResponse } from '@kinetra/shared';
import { CoachingService } from '../src/coaching/service.js';
import { HttpError } from '../src/auth/errors.js';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true' && !databaseUrl)
  throw new Error('DATABASE_URL is required.');
const denies = (code: string) => (error: unknown) =>
  error instanceof HttpError && error.code === code;

test(
  'coaching persists isolated sessions, enforces permissions, quotas and consent, and cleans up videos',
  { skip: !databaseUrl ? 'DATABASE_URL is not configured.' : false },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    const clientId = randomUUID();
    const otherId = randomUUID();
    const trainerId = randomUUID();
    const userIds = [clientId, otherId, trainerId];
    const conversationId = randomUUID();
    const videoAssetId = randomUUID();
    const mediaKey = `chat/videos/test-${videoAssetId}.mp4`;
    try {
      const version = await pool.query(
        "SELECT current_setting('server_version_num')::integer AS version",
      );
      assert.ok(version.rows[0].version >= 170000 && version.rows[0].version < 180000);
      for (const id of userIds)
        await pool.query(
          "INSERT INTO users(id,email,password_hash,onboarding_status) VALUES($1,$2,$3,'active')",
          [
            id,
            `coaching-${id}@example.test`,
            '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
          ],
        );
      const videos = await pool.query(
        "SELECT id FROM videos WHERE type='workout' AND week_number=1 AND day_of_week=1 LIMIT 1",
      );
      const videoId = videos.rows[0]?.id as string;
      assert.ok(videoId, 'Content seed must precede coaching integration tests.');
      let completed = false;
      const getWeek = async (_id: string, week = 1): Promise<WeekResponse> => ({
        week: {
          id: randomUUID(),
          week_number: week,
          title: 'Неделя',
          status: week === 1 ? 'active' : 'locked',
          days: [
            {
              id: randomUUID(),
              day_of_week: 1,
              direction: 'breathing',
              title: 'Дыхание',
              description: 'Авторское описание',
              duration_minutes: 20,
              icon: 'wind',
              video: { id: videoId, video_url: null, poster_url: null },
              completed,
              completed_at: completed ? new Date().toISOString() : null,
            },
          ],
          days_completed: Number(completed),
          total_days: 7,
        },
        total_weeks: 12,
        overall_progress: { total_workouts_done: Number(completed), weeks_completed: 0 },
      });
      const progress: ProgressResponse = {
        goal: {
          current_goal: 'general_health',
          goal_label: 'Здоровье',
          set_at: new Date().toISOString(),
        },
        params: {
          gender: 'male',
          age_range: '26-35',
          experience: 'beginner',
          injuries: [],
          survey_updated_at: new Date().toISOString(),
        },
        metrics: { current_week: 1, pending_survey: false, history: [] },
        achievements: { unlocked: [], locked: [], total_available: 0, total_unlocked: 0 },
        stats: {
          total_workouts: 1,
          total_weeks_completed: 0,
          current_streak: 1,
          best_streak: 1,
          total_minutes_trained: 20,
        },
      };
      const contexts: string[] = [];
      const service = new CoachingService(
        pool,
        { getWeek, getCurrentWeek: getWeek },
        { getProgress: async () => progress },
        {
          answer: async (_question, context) => {
            contexts.push(context);
            return 'Ответ по данным программы.';
          },
        },
      );
      await service.saveSession(clientId, videoId, 1, { position_seconds: 95 });
      assert.equal((await service.getSession(clientId, videoId, 1)).position_seconds, 95);
      assert.equal((await service.getSession(otherId, videoId, 1)).position_seconds, 0);
      await assert.rejects(
        service.saveSession(clientId, videoId, 2, { position_seconds: 10 }),
        denies('WORKOUT_UNAVAILABLE'),
      );
      await assert.rejects(
        service.getSession(clientId, randomUUID(), 1),
        denies('WORKOUT_UNAVAILABLE'),
      );
      await assert.rejects(
        service.saveSession(clientId, videoId, 1, { difficulty: 3 }),
        denies('WORKOUT_NOT_COMPLETED'),
      );
      completed = true;
      await service.saveSession(clientId, videoId, 1, {
        difficulty: 3,
        wellbeing: 4,
        note: 'Личная заметка',
      });
      assert.equal(
        (await service.getSession(clientId, videoId, 1)).position_seconds,
        95,
        'Feedback must preserve the saved position.',
      );
      await assert.rejects(
        service.getGuide(clientId, videoId),
        denies('TRAINER_VIDEO_ACCESS_REQUIRED'),
      );
      await pool.query(
        "INSERT INTO trainer_profiles(user_id,display_name,is_active,can_manage_videos) VALUES($1,'Тестовый тренер',true,false)",
        [trainerId],
      );
      await assert.rejects(
        service.getGuide(trainerId, videoId),
        denies('TRAINER_VIDEO_ACCESS_REQUIRED'),
      );
      await pool.query('UPDATE trainer_profiles SET can_manage_videos=true WHERE user_id=$1', [
        trainerId,
      ]);
      assert.ok(await service.getGuide(trainerId, videoId));
      await pool.query(
        'INSERT INTO chat_conversations(id,client_user_id,trainer_user_id) VALUES($1,$2,$3)',
        [conversationId, clientId, trainerId],
      );
      assert.equal(
        (await service.clientContext(trainerId, conversationId)).recent_sessions[0]?.note,
        'Личная заметка',
      );
      await assert.rejects(
        service.clientContext(otherId, conversationId),
        denies('CONVERSATION_ACCESS_REQUIRED'),
      );
      const question = {
        request_id: randomUUID(),
        question: 'Как устроена программа?',
        use_progress: false,
      };
      const answer = await service.ask(clientId, question);
      assert.equal((await service.ask(clientId, question)).id, answer.id);
      assert.equal(contexts.length, 1, 'Idempotent retry must not call the provider twice.');
      assert.equal(contexts[0]?.includes('completed'), false);
      assert.equal(contexts[0]?.includes('activity'), false);
      assert.equal(contexts[0]?.includes('Личная заметка'), false);
      await assert.rejects(
        service.ask(clientId, { ...question, use_progress: true }),
        denies('COACH_REQUEST_CONFLICT'),
      );
      await service.ask(clientId, { ...question, request_id: randomUUID(), use_progress: true });
      assert.equal(contexts[1]?.includes('activity'), true);
      assert.equal((await service.history(otherId)).messages.length, 0);
      await pool.query('UPDATE coach_daily_usage SET requests=20 WHERE user_id=$1', [clientId]);
      await assert.rejects(
        service.ask(clientId, { ...question, request_id: randomUUID() }),
        denies('COACH_DAILY_LIMIT'),
      );
      await pool.query(
        "INSERT INTO coach_messages(id,user_id,question,status) VALUES($1,$2,'Pending','pending')",
        [randomUUID(), otherId],
      );
      await assert.rejects(
        service.ask(otherId, { ...question, request_id: randomUUID() }),
        denies('COACH_BUSY'),
      );
      await pool.query(
        "INSERT INTO chat_video_assets(id,conversation_id,uploader_user_id,object_key,status,duration_seconds,size_bytes) VALUES($1,$2,$3,$4,'ready',10,1024)",
        [videoAssetId, conversationId, clientId, mediaKey],
      );
      await pool.query('DELETE FROM users WHERE id=$1', [clientId]);
      assert.equal(
        (await pool.query('SELECT 1 FROM workout_sessions WHERE user_id=$1', [clientId])).rowCount,
        0,
      );
      assert.equal(
        (await pool.query('SELECT 1 FROM coach_messages WHERE user_id=$1', [clientId])).rowCount,
        0,
      );
      assert.equal(
        (await pool.query('SELECT 1 FROM chat_video_assets WHERE id=$1', [videoAssetId])).rowCount,
        0,
      );
      assert.equal(
        (await pool.query('SELECT 1 FROM chat_media_deletion_jobs WHERE object_key=$1', [mediaKey]))
          .rowCount,
        1,
      );
    } finally {
      await pool.query('DELETE FROM chat_conversations WHERE id=$1', [conversationId]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
      await pool.query('DELETE FROM chat_media_deletion_jobs WHERE object_key=$1', [mediaKey]);
      await pool.end();
    }
  },
);
