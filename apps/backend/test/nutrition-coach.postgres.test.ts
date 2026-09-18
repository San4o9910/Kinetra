import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Response } from 'express';
import pg from 'pg';
import { TrainingService } from '../src/training/service.js';
import { NutritionService } from '../src/training/nutrition.js';
import { CoachProfiles } from '../src/training/coach-profile.js';
import { TrainingMedia } from '../src/training/media.js';
import { TrainingProgressPhotos } from '../src/training/progress-photos.js';
import { PostgresChatRepository } from '../src/chat/postgres-chat.repository.js';
import { ChatService } from '../src/chat/service.js';
import { ChatEventHub } from '../src/chat/event-hub.js';
import { NoopChatRateLimiter } from '../src/chat/rate-limit.js';
import {
  FakeChatImageProcessor,
  FakeChatMediaStore,
  FixedChatClock,
} from './support/fake-chat-media.js';
import { HttpError } from '../src/auth/errors.js';
const databaseUrl = process.env.DATABASE_URL;
if (process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true' && !databaseUrl)
  throw new Error('DATABASE_URL required');
const denies = (code: string) => (e: unknown) => e instanceof HttpError && e.code === code;
test(
  'nutrition and coaching: private photos, snapshots, idempotent ration, real feedback and chat before onboarding',
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    const users = Array.from({ length: 5 }, () => randomUUID()),
      [trainer, client, otherTrainer, otherClient, unconnected] = users as [
        string,
        string,
        string,
        string,
        string,
      ];
    const service = new TrainingService(pool, true),
      nutrition = new NutritionService(service),
      coaches = new CoachProfiles(service);
    const dir = await mkdtemp(join(tmpdir(), 'kinetra-nutrition-'));
    const media = new TrainingMedia(service, dir, 'nutrition-test-media-secret'),
      photos = new TrainingProgressPhotos(media, 'meal');
    try {
      for (const user of users)
        await pool.query(
          "INSERT INTO users(id,email,password_hash,onboarding_status) VALUES($1,$2,$3,'survey_pending')",
          [
            user,
            `nutrition-${user}@example.test`,
            '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
          ],
        );
      for (const user of [trainer, otherTrainer])
        await pool.query("INSERT INTO trainer_profiles(user_id,display_name) VALUES($1,'Тренер')", [
          user,
        ]);
      const student = await service.createStudent(trainer, { name: 'Анна' });
      await service.acceptInvite(client, { token: student.token });
      const second = await service.createStudent(otherTrainer, { name: 'Другой ученик' });
      await service.acceptInvite(otherClient, { token: second.token });
      const meal = {
        recorded_date: '2026-09-19',
        slot: 'lunch' as const,
        title: 'Обед',
        items: [
          { name: 'Рис варёный', quantity: 150, unit: 'g' as const },
          { name: 'Индейка варёная', quantity: 200, unit: 'g' as const },
          { name: 'Банан', quantity: 1, unit: 'piece' as const },
        ],
        note: 'После тренировки',
        share_with_trainer: false,
        revision: 0,
      };
      const id = randomUUID();
      assert.deepEqual(await nutrition.save(client, id, meal), { id, revision: 1 });
      assert.deepEqual(await nutrition.save(client, id, meal), { id, revision: 1 });
      assert.equal((await nutrition.list(client, meal.recorded_date)).entries.length, 1);
      assert.equal(
        (await nutrition.list(trainer, meal.recorded_date, student.id)).entries.length,
        0,
      );
      await assert.rejects(
        nutrition.list(otherTrainer, meal.recorded_date, student.id),
        denies('STUDENT_NOT_FOUND'),
      );
      await assert.rejects(nutrition.save(otherClient, id, meal), denies('MEAL_UNAVAILABLE'));
      await assert.rejects(
        nutrition.save(client, id, {
          ...meal,
          revision: 1,
          items: [{ name: 'Рис', quantity: -1, unit: 'g' }],
        }),
        denies('INVALID_MEAL'),
      );
      await assert.rejects(
        nutrition.save(client, id, { ...meal, recorded_date: '2026-02-30' }),
        denies('INVALID_MEAL'),
      );
      await assert.rejects(
        nutrition.save(unconnected, randomUUID(), { ...meal, share_with_trainer: true }),
        denies('TRAINER_NOT_CONNECTED'),
      );
      await nutrition.save(client, id, { ...meal, revision: 1, share_with_trainer: true });
      assert.equal(
        (await nutrition.list(trainer, meal.recorded_date, student.id)).entries[0]!.items[2]!
          .quantity,
        1,
      );
      await assert.rejects(
        nutrition.save(client, id, { ...meal, revision: 1, title: 'Stale' }),
        denies('MEAL_CHANGED'),
      );
      const input = join(dir, 'test.png');
      await promisify(execFile)('convert', ['-size', '32x32', 'xc:orange', input]);
      const bytes = await readFile(input);
      await assert.rejects(
        photos.upload(otherClient, id, bytes),
        denies('MEASUREMENT_UNAVAILABLE'),
      );
      await assert.rejects(
        photos.upload(client, id, Buffer.from('<svg>unsafe format</svg>')),
        denies('PHOTO_FORMAT'),
      );
      await photos.upload(client, id, bytes);
      const access = await photos.access(trainer, id);
      const token = new URL(access.path, 'https://example.test').searchParams.get('token');
      let delivered = 0;
      const response = {
        set: () => response,
        send: (b: Buffer) => {
          delivered = b.length;
          return response;
        },
      } as unknown as Response;
      await photos.stream(id, token, response);
      assert.ok(delivered > 0);
      await assert.rejects(photos.access(otherTrainer, id), denies('MEASUREMENT_UNAVAILABLE'));
      await photos.share(client, id, { share: false });
      await assert.rejects(photos.stream(id, token, response), denies('MEASUREMENT_UNAVAILABLE'));
      const ownToken = new URL(
        (await photos.access(client, id)).path,
        'https://example.test',
      ).searchParams.get('token');
      await photos.stream(id, ownToken, response);
      const template = randomUUID(),
        templateBody = {
          name: 'Тренировочный день',
          kind: 'day',
          meals: [
            { slot: meal.slot, title: meal.title, items: meal.items },
            {
              slot: 'dinner',
              title: 'Ужин',
              items: [{ name: 'Творог', quantity: 100, unit: 'g' }],
            },
          ],
        };
      await nutrition.saveTemplate(client, template, templateBody);
      assert.equal((await nutrition.templates(otherClient)).templates.length, 0);
      await assert.rejects(
        nutrition.apply(otherClient, template, {
          request_id: randomUUID(),
          recorded_date: '2026-09-20',
          share_with_trainer: false,
        }),
        denies('TEMPLATE_UNAVAILABLE'),
      );
      const request = {
        request_id: randomUUID(),
        recorded_date: '2026-09-20',
        share_with_trainer: false,
      };
      const [applied, retried] = await Promise.all([
        nutrition.apply(client, template, request),
        nutrition.apply(client, template, request),
      ]);
      assert.deepEqual(applied, retried);
      let copied = (await nutrition.list(client, '2026-09-20')).entries;
      assert.equal(copied.length, 2);
      assert.ok(copied.every((e) => !e.photo_id && !e.share_with_trainer));
      const first = copied[0]!;
      await nutrition.save(client, first.id, {
        ...meal,
        recorded_date: '2026-09-20',
        title: 'Изменённая копия',
        revision: first.revision,
      });
      assert.equal((await nutrition.templates(client)).templates[0]!.meals[0]!.title, 'Обед');
      await nutrition.removeTemplate(client, template);
      assert.equal((await nutrition.list(client, '2026-09-20')).entries.length, 2);
      await assert.rejects(coaches.review(client, { score: 5 }), denies('TRAINING_REQUIRED'));
      const lesson = await service.createLesson(trainer, {
        title: 'Урок',
        size_bytes: 10,
        audience: 'personal',
        personal_student_id: student.id,
      });
      await pool.query("UPDATE training_lessons SET status='ready' WHERE id=$1", [lesson.id]);
      await pool.query(
        'UPDATE training_lesson_assignments SET completed_at=now() WHERE lesson_id=$1',
        [lesson.id],
      );
      await coaches.review(client, { score: 5 });
      await coaches.review(client, { score: 4 });
      const profile = await coaches.profile(trainer);
      assert.equal(profile.rating, 4);
      assert.equal(profile.review_count, 1);
      assert.equal(profile.active_students, 1);
      assert.equal(profile.ready_lessons, 1);
      assert.equal(profile.level, 'Старт');
      assert.equal((await coaches.mine(client)).can_review, true);
      await assert.rejects(coaches.review(otherClient, { score: 5 }), denies('TRAINING_REQUIRED'));
      const session = randomUUID(),
        now = new Date();
      await pool.query(
        "INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
        [session, client, createHash('sha256').update(session).digest('hex')],
      );
      const repository = new PostgresChatRepository(pool);
      const chat = new ChatService({
        repository,
        eventPublisher: new ChatEventHub(),
        rateLimiter: new NoopChatRateLimiter(),
        imageProcessor: new FakeChatImageProcessor(),
        mediaStore: new FakeChatMediaStore(),
        clock: new FixedChatClock(now),
        enabled: true,
        photoUploadsEnabled: false,
        mediaUrlTtlSeconds: 300,
        cursorSecret: 'nutrition-chat-cursor-secret-long-enough',
      });
      const context = { userId: client, sessionId: session, ip: '127.0.0.1' };
      const chatSession = await chat.getSession(context);
      assert.equal(chatSession.role, 'client');
      assert.ok(chatSession.role === 'client' && chatSession.conversation);
      if (chatSession.role !== 'client' || !chatSession.conversation)
        throw new Error('Conversation required');
      const conversationId = chatSession.conversation.id;
      const sent = await chat.sendMessage(context, conversationId, {
        kind: 'text',
        text: 'Вопрос по тренировке',
        client_message_id: randomUUID(),
      });
      assert.equal(sent.message.text, 'Вопрос по тренировке');
      assert.ok(await chat.getSocketActor(client, session));
      assert.equal(await chat.validateSocketIdentity(client, session, 'client'), 'active');
      assert.ok(
        await repository.findRealtimeRecipientConversation(client, 'client', conversationId),
      );
      assert.ok(await repository.getRealtimeConversation(conversationId));
      const trainerMessages = await repository.listMessages({
        userId: trainer,
        conversationId,
        beforeSequence: null,
        afterSequence: null,
        limit: 30,
      });
      assert.equal(trainerMessages?.messages[0]?.body, 'Вопрос по тренировке');
      assert.equal(
        await repository.listMessages({
          userId: otherTrainer,
          conversationId,
          beforeSequence: null,
          afterSequence: null,
          limit: 30,
        }),
        null,
      );
      await photos.share(client, id, { share: true });
      const beforeArchive = new URL(
        (await photos.access(trainer, id)).path,
        'https://example.test',
      ).searchParams.get('token');
      await service.archiveStudent(trainer, student.id);
      await assert.rejects(
        photos.stream(id, beforeArchive, response),
        denies('MEASUREMENT_UNAVAILABLE'),
      );
      assert.equal((await coaches.profile(trainer)).review_count, 1);
      assert.equal((await coaches.profile(trainer)).active_students, 0);
      await photos.remove(client, id);
      assert.equal((await nutrition.list(client, meal.recorded_date)).entries.length, 0);
      await assert.rejects(
        photos.stream(id, ownToken, response),
        denies('MEASUREMENT_UNAVAILABLE'),
      );
      copied = (await nutrition.list(client, '2026-09-20')).entries;
      assert.equal(copied.length, 2);
      console.log('KINETRA_NUTRITION_COACH_CHAT_POSTGRES=PASS');
    } finally {
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      await pool.end();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
