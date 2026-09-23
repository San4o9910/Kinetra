import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { TrainingService } from '../src/training/service.js';
import { LessonAssignments } from '../src/training/lesson-assignments.js';
import { TrainingExperience } from '../src/training/experience.js';
import { HttpError } from '../src/auth/errors.js';
const databaseUrl = process.env.DATABASE_URL;
if (process.env.KINETRA_REQUIRE_POSTGRES_TEST === 'true' && !databaseUrl)
  throw Error('DATABASE_URL required');
const denied = (code: string) => (e: unknown) => e instanceof HttpError && e.code === code;
test(
  'lesson assignment isolates personal media, snapshots all recipients, preserves independent progress and revokes access',
  { skip: !databaseUrl },
  async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 }),
      training = new TrainingService(pool, true),
      assignments = new LessonAssignments(training),
      experience = new TrainingExperience(training);
    const trainer = randomUUID(),
      other = randomUUID(),
      a = randomUUID(),
      b = randomUUID(),
      c = randomUUID(),
      users = [trainer, other, a, b, c];
    try {
      for (const id of users)
        await pool.query(
          "INSERT INTO users(id,email,password_hash,onboarding_status) VALUES($1,$2,$3,'active')",
          [
            id,
            `sharing-${id}@example.test`,
            '$2b$10$abcdefghijklmnopqrstuv12345678901234567890123456789012',
          ],
        );
      for (const id of [trainer, other])
        await pool.query(
          "INSERT INTO trainer_profiles(user_id,display_name,can_manage_videos) VALUES($1,'Тренер',false)",
          [id],
        );
      const sa = await training.createStudent(trainer, { name: 'Анна' }),
        sb = await training.createStudent(trainer, { name: 'Борис' }),
        foreign = await training.createStudent(other, { name: 'Чужой' });
      await training.acceptInvite(a, { token: sa.token });
      await training.acceptInvite(b, { token: sb.token });
      await training.acceptInvite(c, { token: foreign.token });
      await assert.rejects(
        training.createLesson(trainer, {
          title: 'Чужой персональный',
          size_bytes: 1,
          audience: 'personal',
          personal_student_id: foreign.id,
        }),
        denied('STUDENT_NOT_FOUND'),
      );
      const shared = await training.createLesson(trainer, { title: 'Общий', size_bytes: 1 }),
        personal = await training.createLesson(trainer, {
          title: 'Только Анне',
          size_bytes: 1,
          audience: 'personal',
          personal_student_id: sa.id,
        });
      await assert.rejects(
        assignments.assign(trainer, shared.id, { target: 'all' }),
        denied('LESSON_UNAVAILABLE'),
      );
      await pool.query(
        "UPDATE training_lessons SET status='ready',duration_seconds=60 WHERE id=ANY($1::uuid[])",
        [[shared.id, personal.id]],
      );
      await assert.rejects(training.mediaAccess(a, shared.id), denied('LESSON_UNAVAILABLE'));
      await training.mediaAccess(a, personal.id);
      await assert.rejects(training.mediaAccess(b, personal.id), denied('LESSON_UNAVAILABLE'));
      await assert.rejects(
        assignments.recipients(other, personal.id),
        denied('LESSON_UNAVAILABLE'),
      );
      await assert.rejects(
        assignments.assign(trainer, personal.id, { target: 'all' }),
        denied('PERSONAL_LESSON'),
      );
      await assert.rejects(
        assignments.assign(trainer, personal.id, { target: 'selected', student_ids: [sb.id] }),
        denied('PERSONAL_LESSON'),
      );
      await assert.rejects(
        assignments.assign(trainer, shared.id, {
          target: 'selected',
          student_ids: [sa.id, foreign.id],
        }),
        denied('INVALID_RECIPIENTS'),
      );
      assert.equal(
        (await assignments.recipients(trainer, shared.id)).recipients.length,
        0,
        'Mixed invalid batch must be atomic',
      );
      await assignments.assign(trainer, shared.id, { target: 'selected', student_ids: [sa.id] });
      await training.mediaAccess(a, shared.id);
      await assert.rejects(training.mediaAccess(b, shared.id), denied('LESSON_UNAVAILABLE'));
      await assignments.progress(a, shared.id, { position_seconds: 45, completed: true });
      await assignments.assign(trainer, shared.id, { target: 'all' });
      await assignments.assign(trainer, shared.id, { target: 'all' });
      assert.equal((await assignments.recipients(trainer, shared.id)).recipients.length, 2);
      const pending = await training.createStudent(trainer, { name: 'Позже' });
      assert.equal(
        (await training.detail(trainer, pending.id)).assigned_lessons!.length,
        0,
        'New students are not silently included',
      );
      const mineA = (await training.myTraining(a)).assigned_lessons!,
        mineB = (await training.myTraining(b)).assigned_lessons!;
      assert.ok(mineA.find((l) => l.id === shared.id)!.completed_at);
      assert.equal(mineB[0]!.completed_at, null);
      assert.equal(mineB[0]!.position_seconds, 0);
      assert.equal((await training.myTraining(c)).assigned_lessons!.length, 0);
      await assert.rejects(
        assignments.progress(c, shared.id, { completed: true }),
        denied('LESSON_UNAVAILABLE'),
      );
      const plan = await training.createPlan(trainer, sb.id),
        w = {
          id: randomUUID(),
          title: 'Тест',
          instructions: '',
          scheduled_date: null,
          duration_minutes: 30,
          lesson_id: personal.id,
          exercises: [],
        };
      await assert.rejects(
        training.savePlan(trainer, plan.id, {
          title: 'Программа',
          goal: '',
          revision: 1,
          workouts: [w],
        }),
        denied('LESSON_UNAVAILABLE'),
      );
      const ownPlan = await training.createPlan(trainer, sa.id);
      await training.savePlan(trainer, ownPlan.id, {
        title: 'Своя программа',
        goal: '',
        revision: 1,
        workouts: [w],
      });
      const template = await experience.saveTemplate(trainer, ownPlan.id);
      await assert.rejects(
        experience.assignTemplate(trainer, sb.id, { template_id: template.id }),
        denied('LESSON_UNAVAILABLE'),
      );
      await assignments.revoke(trainer, shared.id, sa.id);
      await assert.rejects(training.mediaAccess(a, shared.id), denied('LESSON_UNAVAILABLE'));
      await assert.rejects(
        assignments.progress(a, shared.id, { completed: true }),
        denied('LESSON_UNAVAILABLE'),
      );
      await training.mediaAccess(b, shared.id);
      await assignments.assign(trainer, shared.id, { target: 'selected', student_ids: [sa.id] });
      assert.ok(
        (await training.myTraining(a)).assigned_lessons!.find((l) => l.id === shared.id)!
          .completed_at,
        'Reassigning retains history',
      );
      await training.archiveStudent(trainer, sb.id);
      await assert.rejects(training.mediaAccess(b, shared.id), denied('LESSON_UNAVAILABLE'));
      await pool.query('UPDATE trainer_profiles SET is_active=false WHERE user_id=$1', [trainer]);
      await assert.rejects(training.mediaAccess(a, personal.id), denied('LESSON_UNAVAILABLE'));
    } finally {
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users]);
      await pool.end();
    }
  },
);
