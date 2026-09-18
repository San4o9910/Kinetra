import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import pg from 'pg';
import { TrainingService } from '../src/training/service.js';
import { TrainingExperience } from '../src/training/experience.js';
import { TrainingMedia } from '../src/training/media.js';
import { ResumableTrainingMedia } from '../src/training/resumable-media.js';
import { TrainingProgressPhotos } from '../src/training/progress-photos.js';
import { TrainingReminders } from '../src/training/reminders.js';
import { PostgresPushRepository } from '../src/push/postgres-push.repository.js';
import { HttpError } from '../src/auth/errors.js';
const databaseUrl = process.env.DATABASE_URL;
if (process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true' && !databaseUrl)
  throw new Error('DATABASE_URL required');
const denies = (code: string) => (e: unknown) => e instanceof HttpError && e.code === code;
const execute = promisify(execFile);
test(
  'training experience: independent templates, set revisions, consent, rescheduling, audit and resumable HEVC',
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    const training = new TrainingService(pool, true),
      experience = new TrainingExperience(training);
    const trainer = randomUUID(),
      otherTrainer = randomUUID(),
      client = randomUUID(),
      otherClient = randomUUID(),
      admin = randomUUID();
    const users = [trainer, otherTrainer, client, otherClient, admin];
    const directory = await mkdtemp(join(tmpdir(), 'kinetra-experience-'));
    const media = new TrainingMedia(training, join(directory, 'private'), 'experience-test-secret');
    const uploads = new ResumableTrainingMedia(media),
      photos = new TrainingProgressPhotos(media);
    try {
      for (const id of users)
        await pool.query(
          "INSERT INTO users(id,email,password_hash,onboarding_status,timezone) VALUES($1,$2,$3,'active','UTC')",
          [
            id,
            `experience-${id}@example.test`,
            '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
          ],
        );
      for (const id of [trainer, otherTrainer])
        await pool.query(
          "INSERT INTO trainer_profiles(user_id,display_name,can_manage_videos) VALUES($1,'Тренер',false)",
          [id],
        );
      await pool.query('INSERT INTO trainer_verification_reviewers(user_id) VALUES($1)', [admin]);
      const student = await training.createStudent(trainer, { name: 'Анна' }),
        second = await training.createStudent(trainer, { name: 'Елена' });
      await training.acceptInvite(client, { token: student.token });
      await training.acceptInvite(otherClient, { token: second.token });
      const input = join(directory, 'iphone.mov');
      await execute(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=orange:s=320x240:r=15',
          '-t',
          '1',
          '-c:v',
          'libx265',
          '-threads',
          '1',
          '-x265-params',
          'pools=1:frame-threads=1:log-level=error',
          '-tag:v',
          'hvc1',
          input,
        ],
        { timeout: 30000, maxBuffer: 65536 },
      );
      const bytes = await readFile(input);
      const lesson = await training.createLesson(trainer, {
        title: 'Урок с телефона',
        original_name: 'iphone.mov',
        source_modified: 1234,
        folder: 'Ноги',
        size_bytes: bytes.length,
      });
      const chunk = (start: number, end: number) =>
        Object.assign(Readable.from([bytes.subarray(start, end)]), {
          get: (name: string) =>
            ({
              'content-type': 'application/octet-stream',
              'content-length': String(end - start),
              'x-upload-offset': String(start),
            })[name],
        }) as unknown as Request;
      const middle = Math.floor(bytes.length / 2);
      await assert.rejects(
        uploads.chunk(otherTrainer, lesson.id, chunk(0, middle)),
        denies('UPLOAD_STATE'),
      );
      await uploads.chunk(trainer, lesson.id, chunk(0, middle));
      assert.equal((await uploads.status(trainer, lesson.id)).offset, middle);
      await assert.rejects(
        uploads.chunk(trainer, lesson.id, chunk(0, middle)),
        denies('UPLOAD_OFFSET'),
      );
      await assert.rejects(uploads.finish(trainer, lesson.id), denies('UPLOAD_INCOMPLETE'));
      await uploads.chunk(trainer, lesson.id, chunk(middle, bytes.length));
      await uploads.finish(trainer, lesson.id);
      await uploads.processNext();
      const ready = (await training.library(trainer)).lessons[0]!;
      assert.equal(ready.status, 'ready');
      assert.equal(ready.thumbnail_ready, true);
      assert.equal((await stat(media.path(lesson.id))).mode & 0o777, 0o600);
      const probe = JSON.parse(
        (
          await execute('ffprobe', [
            '-v',
            'error',
            '-show_streams',
            '-of',
            'json',
            media.path(lesson.id),
          ])
        ).stdout,
      );
      assert.equal(probe.streams[0].codec_name, 'h264');
      const plan = await training.createPlan(trainer, student.id),
        date = '2026-09-19';
      const exercise = {
        id: randomUUID(),
        name: 'Приседания',
        sets: 3,
        repetitions: 12,
        seconds: null,
        weight_kg: 10,
        rest_seconds: 60,
        lesson_id: lesson.id,
      };
      const workout = {
        id: randomUUID(),
        title: 'Ноги',
        instructions: 'Контроль техники',
        scheduled_date: date,
        duration_minutes: 30,
        lesson_id: null,
        exercises: [exercise],
      };
      await training.savePlan(trainer, plan.id, {
        title: 'Сила',
        goal: 'Три недели',
        revision: 1,
        workouts: [workout],
      });
      await training.publishPlan(trainer, plan.id, { revision: 2 });
      const template = await experience.saveTemplate(trainer, plan.id);
      assert.equal((await experience.templates(otherTrainer)).templates.length, 0);
      await assert.rejects(
        experience.assignTemplate(otherTrainer, second.id, { template_id: template.id }),
        denies('STUDENT_NOT_FOUND'),
      );
      const copy = await experience.assignTemplate(trainer, second.id, {
        template_id: template.id,
        start_date: '2026-09-22',
      });
      const copied = (await training.detail(trainer, second.id)).plans.find(
        (p) => p.id === copy.id,
      )!;
      assert.equal(copied.status, 'draft');
      assert.equal(copied.workouts[0]!.scheduled_date, '2026-09-22');
      assert.notEqual(copied.workouts[0]!.id, workout.id);
      assert.notEqual(copied.workouts[0]!.exercises![0]!.id, exercise.id);
      await training.savePlan(trainer, copy.id, {
        title: 'Елена: другая нагрузка',
        goal: '',
        revision: 1,
        workouts: [
          {
            ...workout,
            id: copied.workouts[0]!.id,
            exercises: [{ ...exercise, id: copied.workouts[0]!.exercises![0]!.id, weight_kg: 5 }],
          },
        ],
      });
      assert.equal(
        (await training.myTraining(client)).plans[0]!.workouts[0]!.exercises![0]!.weight_kg,
        10,
      );
      await training.mediaAccess(client, lesson.id);
      await assert.rejects(
        training.mediaAccess(otherClient, lesson.id),
        denies('LESSON_UNAVAILABLE'),
      );
      const request = await experience.requestReschedule(client, workout.id, {
        requested_date: '2026-09-20',
        reason: 'Не успеваю',
      });
      assert.ok((await experience.attention(trainer)).events.some((e) => e.kind === 'reschedule'));
      await assert.rejects(
        experience.reviewReschedule(otherTrainer, request.id, { approve: true }),
        denies('STUDENT_NOT_FOUND'),
      );
      await experience.reviewReschedule(trainer, request.id, { approve: true });
      assert.equal(
        (await training.myTraining(client)).plans[0]!.workouts[0]!.scheduled_date,
        '2026-09-20',
      );
      const record = {
        exercise_id: exercise.id,
        set: 1,
        repetitions: 10,
        seconds: null,
        weight_kg: 10,
        completed: true,
      };
      await training.log(client, workout.id, { base_revision: 0, set_records: [record] });
      await assert.rejects(
        training.log(client, workout.id, { base_revision: 0, set_records: [] }),
        denies('LOG_CHANGED'),
      );
      await assert.rejects(
        training.log(client, workout.id, {
          base_revision: 1,
          set_records: [{ ...record, set: 4 }],
        }),
        denies('INVALID_SET'),
      );
      const current = (await training.myTraining(client)).plans[0]!;
      await assert.rejects(
        training.savePlan(trainer, plan.id, {
          title: current.title,
          goal: current.goal,
          revision: current.revision,
          workouts: [],
        }),
        denies('EMPTY_PLAN'),
      );
      await assert.rejects(
        training.savePlan(trainer, plan.id, {
          title: current.title,
          goal: current.goal,
          revision: current.revision,
          workouts: [{ ...workout, title: 'Изменено', scheduled_date: '2026-09-20' }],
        }),
        denies('COMPLETED_WORKOUT'),
      );
      const measurement = await experience.addMeasurement(client, {
        recorded_date: date,
        weight_kg: 70,
        waist_cm: null,
        chest_cm: null,
        hips_cm: null,
        note: 'Личное',
        share_with_trainer: false,
      });
      assert.equal((await experience.measurements(trainer, student.id)).measurements.length, 0);
      const photoFile = join(directory, 'photo.png');
      await execute('convert', ['-size', '60x80', 'xc:orange', photoFile]);
      await photos.upload(client, measurement.id, await readFile(photoFile));
      await assert.rejects(
        photos.access(trainer, measurement.id),
        denies('MEASUREMENT_UNAVAILABLE'),
      );
      await photos.share(client, measurement.id, { share: true });
      const access = await photos.access(trainer, measurement.id);
      assert.equal((await experience.measurements(trainer, student.id)).measurements.length, 1);
      await assert.rejects(
        photos.access(otherTrainer, measurement.id),
        denies('MEASUREMENT_UNAVAILABLE'),
      );
      await photos.share(client, measurement.id, { share: false });
      await assert.rejects(
        photos.stream(
          measurement.id,
          new URL(access.path, 'https://test.invalid').searchParams.get('token'),
          {} as Response,
        ),
        denies('MEASUREMENT_UNAVAILABLE'),
      );
      await assert.rejects(
        photos.upload(client, measurement.id, Buffer.from('<svg>untrusted format</svg>')),
        denies('PHOTO_FORMAT'),
      );
      const complaint = await experience.complain(client, {
        reason: 'Нужна помощь с работой тренера',
      });
      await assert.rejects(experience.complaints(trainer, true), denies('REVIEWER_REQUIRED'));
      assert.equal((await experience.complaints(otherClient)).complaints.length, 0);
      await experience.reviewComplaint(admin, complaint.id, {
        status: 'reviewing',
        resolution: 'Уточняем детали',
        revision: 1,
      });
      await assert.rejects(
        experience.reviewComplaint(admin, complaint.id, {
          status: 'resolved',
          resolution: 'Готово',
          revision: 1,
        }),
        denies('COMPLAINT_CHANGED'),
      );
      await assert.rejects(
        pool.query("UPDATE training_complaint_events SET reason='changed' WHERE complaint_id=$1", [
          complaint.id,
        ]),
        (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === '55000',
      );
      await experience.reviewComplaint(admin, complaint.id, {
        status: 'resolved',
        resolution: 'Вопрос решён',
        revision: 2,
      });
      assert.equal((await experience.complaints(client)).complaints[0]!.events.length, 3);
      const push = new PostgresPushRepository(pool);
      await push.upsertSubscription({
        userId: client,
        endpoint: `https://push.example.test/${randomUUID()}`,
        p256dh: 'A'.repeat(87),
        auth: 'B'.repeat(22),
        expirationTime: null,
        userAgent: null,
      });
      await pool.query('UPDATE users SET notification_preferences=$2::jsonb WHERE id=$1', [
        client,
        JSON.stringify({
          workout_reminders: true,
          reminder_time: '09:00',
          weekly_survey_reminder: false,
        }),
      ]);
      let sent = 0;
      const reminders = new TrainingReminders(pool, {
        send: async (_subscription, payload) => {
          assert.equal(payload.url, '/schedule');
          assert.equal(payload.body.includes('Приседания'), false);
          sent++;
          return { kind: 'sent' };
        },
      });
      const when = new Date('2026-09-20T09:00:00Z');
      await reminders.run(when);
      await reminders.run(when);
      assert.equal(sent, 1);
      await pool.query(
        "UPDATE users SET notification_preferences=jsonb_set(notification_preferences,'{workout_reminders}','false') WHERE id=$1",
        [client],
      );
      assert.equal((await reminders.run(when)).selected, 0);
      await training.log(client, workout.id, {
        base_revision: 1,
        completed: true,
        set_records: [record],
        note: 'Выполнено',
      });
      assert.ok((await experience.attention(trainer)).events.some((e) => e.kind === 'report'));
      await experience.seen(trainer, student.id);
      assert.equal(
        (await experience.attention(trainer)).events.some((e) => e.kind === 'report'),
        false,
      );
      assert.equal((await training.detail(trainer, second.id)).student.completed, 0);
      await training.archiveStudent(trainer, student.id);
      await assert.rejects(
        experience.measurements(trainer, student.id),
        denies('STUDENT_NOT_FOUND'),
      );
      await assert.rejects(training.mediaAccess(client, lesson.id), denies('LESSON_UNAVAILABLE'));
      await uploads.processNext();
      console.log('KINETRA_TRAINING_EXPERIENCE_POSTGRES=PASS');
    } finally {
      await uploads.stop();
      await pool.query('DELETE FROM chat_conversations WHERE client_user_id=ANY($1::uuid[])', [
        users,
      ]);
      await pool.query('DELETE FROM training_students WHERE trainer_id=ANY($1::uuid[])', [users]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
