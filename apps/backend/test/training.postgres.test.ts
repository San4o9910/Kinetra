import { CoachingService } from '../src/coaching/service.js';
import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { HmacJwtAccessTokenService } from '../src/auth/tokens.js';
import { createTrainingRouter } from '../src/training/router.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import pg from 'pg';
import { TrainingService } from '../src/training/service.js';
import { TrainingMedia } from '../src/training/media.js';
import { HttpError } from '../src/auth/errors.js';
const databaseUrl = process.env.DATABASE_URL;
if (process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true' && !databaseUrl)
  throw new Error('DATABASE_URL required');
const denies = (code: string) => (error: unknown) =>
  error instanceof HttpError && error.code === code;
test(
  'trainer workspace persists invitation, personal plan, real video and isolated student progress',
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
    const service = new TrainingService(pool, true);
    const trainer = randomUUID(),
      otherTrainer = randomUUID(),
      client = randomUUID(),
      otherClient = randomUUID();
    const users = [trainer, otherTrainer, client, otherClient];
    const folder = await mkdtemp(join(tmpdir(), 'kinetra-training-'));
    const media = new TrainingMedia(
      service,
      join(folder, 'private'),
      'test-not-real-signing-secret',
    );
    try {
      for (const id of users)
        await pool.query(
          "INSERT INTO users(id,email,password_hash,onboarding_status) VALUES($1,$2,$3,'active')",
          [
            id,
            `training-${id}@example.test`,
            '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
          ],
        );
      for (const id of [trainer, otherTrainer])
        await pool.query(
          "INSERT INTO trainer_profiles(user_id,display_name,can_manage_videos) VALUES($1,'Тренер',false)",
          [id],
        );
      await assert.rejects(service.listStudents(client), denies('TRAINER_REQUIRED'));
      const student = await service.createStudent(trainer, {
        name: 'Анна',
        contact: 'Личный контакт',
      });
      assert.equal((await service.listStudents(trainer)).students.length, 1);
      assert.equal(
        JSON.stringify(await service.listStudents(trainer)).includes('invite_hash'),
        false,
      );
      assert.equal((await service.listStudents(otherTrainer)).students.length, 0);
      await assert.rejects(service.detail(otherTrainer, student.id), denies('STUDENT_NOT_FOUND'));
      assert.equal((await service.invitation({ token: student.token })).trainer_name, 'Тренер');
      await assert.rejects(
        service.acceptInvite(trainer, { token: student.token }),
        denies('CLIENT_REQUIRED'),
      );
      await service.acceptInvite(client, { token: student.token });
      await assert.rejects(
        service.acceptInvite(otherClient, { token: student.token }),
        denies('INVITE_EXPIRED'),
      );
      const my = await service.myTraining(client);
      assert.equal(my.student_id, student.id);
      assert.deepEqual(my.plans, []);
      assert.equal((await service.myTraining(otherClient)).student_id, null);
      const lessonFile = join(folder, 'source.mp4');
      await promisify(execFile)(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=orange:s=320x240:r=15',
          '-t',
          '2',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          lessonFile,
        ],
        { timeout: 30_000 },
      );
      const bytes = await readFile(lessonFile);
      const lesson = await service.createLesson(trainer, {
        title: 'Мой урок',
        size_bytes: bytes.length,
      });
      const upload = () =>
        Object.assign(Readable.from([bytes]), {
          get: (name: string) =>
            name === 'content-type'
              ? 'video/mp4'
              : name === 'content-length'
                ? String(bytes.length)
                : undefined,
        }) as unknown as Request;
      await assert.rejects(media.upload(otherTrainer, lesson.id, upload()), denies('UPLOAD_STATE'));
      await media.upload(trainer, lesson.id, upload());
      assert.equal((await service.library(trainer)).lessons[0]?.status, 'ready');
      assert.equal((await service.library(otherTrainer)).lessons.length, 0);
      await assert.rejects(
        service.mediaAccess(otherTrainer, lesson.id),
        denies('LESSON_UNAVAILABLE'),
      );
      await assert.rejects(service.mediaAccess(client, lesson.id), denies('LESSON_UNAVAILABLE'));
      const plan = await service.createPlan(trainer, student.id);
      const workout = {
        id: randomUUID(),
        title: 'Урок с тренером',
        instructions: '3 подхода по 12',
        scheduled_date: '2026-09-19',
        duration_minutes: 30,
        lesson_id: lesson.id,
      };
      let input = {
        title: 'Персональная программа',
        goal: 'Моя цель',
        revision: 1,
        workouts: [workout],
      };
      const saved = await service.savePlan(trainer, plan.id, input);
      input = { ...input, revision: saved.revision };
      assert.equal((await service.myTraining(client)).plans.length, 0, 'Draft stays private');
      await assert.rejects(
        service.savePlan(otherTrainer, plan.id, input),
        denies('STUDENT_NOT_FOUND'),
      );
      await service.publishPlan(trainer, plan.id, { revision: saved.revision });
      assert.equal((await service.myTraining(client)).plans[0]?.workouts[0]?.title, workout.title);
      await service.mediaAccess(client, lesson.id);
      // Actual HTTP boundary and byte-range playback use the same JWT middleware as production.
      const tokens = new HmacJwtAccessTokenService(
        'training-test-access-secret-at-least-32-bytes',
        'training-test',
        'training-test',
        900,
      );
      const app = express();
      app.use(express.json());
      app.use(
        '/api/v1/training',
        createTrainingRouter(service, media, createAuthMiddleware(tokens)),
      );
      const errors: ErrorRequestHandler = (error, _request, response, _next) => {
        response
          .status(error instanceof HttpError ? error.statusCode : 500)
          .json({ error: { code: error instanceof HttpError ? error.code : 'INTERNAL' } });
      };
      app.use(errors);
      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const origin = `http://127.0.0.1:${address.port}`;
        assert.equal((await fetch(origin + '/api/v1/training/students')).status, 401);
        const clientToken = (await tokens.issue(client, randomUUID(), new Date())).token;
        assert.equal(
          (
            await fetch(origin + '/api/v1/training/students', {
              headers: { Authorization: `Bearer ${clientToken}` },
            })
          ).status,
          403,
        );
        const playback = await fetch(origin + `/api/v1/training/lessons/${lesson.id}/access`, {
          headers: { Authorization: `Bearer ${clientToken}` },
        });
        assert.equal(playback.status, 200);
        const access = (await playback.json()) as { path: string };
        const ranged = await fetch(origin + access.path, { headers: { Range: 'bytes=0-15' } });
        assert.equal(ranged.status, 206);
        assert.equal(ranged.headers.get('cache-control'), 'private, no-store');
        assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 16));
        assert.equal((await fetch(origin + access.path + '&token=forged')).status, 401);
        assert.equal(
          (await fetch(origin + access.path, { headers: { Range: 'bytes=999999999-' } })).status,
          416,
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
      }
      await assert.rejects(
        service.mediaAccess(otherClient, lesson.id),
        denies('LESSON_UNAVAILABLE'),
      );
      await assert.rejects(
        service.log(otherClient, workout.id, { completed: true }),
        denies('WORKOUT_UNAVAILABLE'),
      );
      await service.log(client, workout.id, { position_seconds: 1 });
      await service.log(client, workout.id, {
        completed: true,
        difficulty: 3,
        wellbeing: 4,
        note: 'Всё получилось',
      });
      await service.log(client, workout.id, { completed: true });
      let detail = await service.detail(trainer, student.id);
      assert.equal(detail.student.completed, 1);
      const legacyUnavailable = async (): Promise<never> => {
        throw new Error('Personal student must not require the platform course or survey');
      };
      const coaching = new CoachingService(
        pool,
        { getWeek: legacyUnavailable, getCurrentWeek: legacyUnavailable },
        { getProgress: legacyUnavailable },
        null,
      );
      const context = await coaching.clientContext(trainer, detail.student.conversation_id!);
      assert.equal(context.personal_training?.student.completed, 1);
      assert.equal(context.progress, null);
      await assert.rejects(
        coaching.clientContext(otherTrainer, detail.student.conversation_id!),
        denies('CONVERSATION_ACCESS_REQUIRED'),
      );
      assert.equal(detail.student.minutes, 30);
      assert.equal(detail.plans[0]?.workouts[0]?.note, 'Всё получилось');
      assert.equal(detail.plans[0]?.workouts[0]?.position_seconds, 1);
      await assert.rejects(
        service.savePlan(trainer, plan.id, {
          ...input,
          revision: detail.plans[0]!.revision,
          workouts: [],
        }),
        denies('EMPTY_PLAN'),
      );
      await assert.rejects(
        service.savePlan(trainer, plan.id, {
          ...input,
          revision: detail.plans[0]!.revision,
          workouts: [{ ...workout, title: 'Переписанная история' }],
        }),
        denies('COMPLETED_WORKOUT'),
      );
      await assert.rejects(service.savePlan(trainer, plan.id, input), denies('PLAN_CHANGED'));
      await assert.rejects(media.remove(trainer, lesson.id), denies('LESSON_IN_USE'));
      const next = await service.createPlan(trainer, student.id);
      const nextWork = { ...workout, id: randomUUID(), title: 'Следующее занятие' };
      await service.savePlan(trainer, next.id, { ...input, revision: 1, workouts: [nextWork] });
      await service.publishPlan(trainer, next.id, { revision: 2 });
      detail = await service.detail(trainer, student.id);
      assert.equal(detail.student.completed, 0);
      assert.equal(detail.student.minutes, 30);
      assert.equal(detail.plans.filter((p) => p.status === 'archived').length, 1);
      await assert.rejects(
        service.log(client, workout.id, { completed: true }),
        denies('WORKOUT_UNAVAILABLE'),
      );
      const secondStudent = await service.createStudent(trainer, { name: 'Иван' });
      const renewed = await service.renewInvite(trainer, secondStudent.id);
      await assert.rejects(
        service.invitation({ token: secondStudent.token }),
        denies('INVITE_EXPIRED'),
      );
      await service.acceptInvite(otherClient, { token: renewed.token });
      assert.equal((await service.detail(trainer, secondStudent.id)).student.completed, 0);
      await assert.rejects(
        service.mediaAccess(otherClient, lesson.id),
        denies('LESSON_UNAVAILABLE'),
      );
      await pool.query('UPDATE trainer_profiles SET is_active=false WHERE user_id=$1', [trainer]);
      await assert.rejects(service.mediaAccess(client, lesson.id), denies('LESSON_UNAVAILABLE'));
      await assert.rejects(service.listStudents(trainer), denies('TRAINER_REQUIRED'));
      await pool.query('UPDATE trainer_profiles SET is_active=true WHERE user_id=$1', [trainer]);
      await service.archiveStudent(trainer, student.id);
      assert.equal((await service.myTraining(client)).student_id, null);
      await assert.rejects(
        coaching.clientContext(trainer, detail.student.conversation_id!),
        denies('CONVERSATION_ACCESS_REQUIRED'),
      );
      assert.equal((await service.detail(trainer, student.id)).student.minutes, 30);
      await assert.rejects(service.mediaAccess(client, lesson.id), denies('LESSON_UNAVAILABLE'));
      console.log('KINETRA_TRAINER_WORKSPACE_POSTGRES=PASS');
    } finally {
      await pool.query('DELETE FROM chat_conversations WHERE client_user_id=ANY($1::uuid[])', [
        users,
      ]);
      await pool.query('DELETE FROM training_students WHERE trainer_id=ANY($1::uuid[])', [users]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      await pool.end();
      await rm(folder, { recursive: true, force: true });
    }
  },
);
