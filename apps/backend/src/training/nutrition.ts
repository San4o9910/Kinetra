import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { NutritionEntry, NutritionTemplate } from '@kinetra/shared';
import { type TrainingService, trainingError, trainingId } from './service.js';
import { date, uuid } from './schema.js';
const text = (max: number) => z.string().trim().max(max);
const food = z
  .object({
    name: text(120).min(1),
    quantity: z.number().finite().positive().max(10000),
    unit: z.enum(['g', 'ml', 'piece']),
  })
  .strict();
const contents = z
  .object({
    slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
    title: text(120),
    items: z.array(food).min(1).max(40),
  })
  .strict();
const entry = contents
  .extend({
    recorded_date: date,
    note: text(1000),
    share_with_trainer: z.boolean(),
    revision: z.number().int().min(0).max(1000000),
  })
  .strict();
const template = z
  .object({
    name: text(120).min(1),
    kind: z.enum(['portion', 'meal', 'day']),
    meals: z.array(contents).min(1).max(12),
  })
  .strict()
  .refine(
    (v) =>
      v.kind === 'day' ||
      (v.meals.length === 1 && (v.kind !== 'portion' || v.meals[0]!.items.length === 1)),
  );
const columns = 'id,recorded_date::text,slot,title,items,note,share_with_trainer,photo_id,revision';
export class NutritionService {
  public constructor(private readonly service: TrainingService) {}
  private async lockClient(db: PoolClient, user: string) {
    const r = await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user]);
    if (!r.rows[0]) trainingError(401, 'AUTHENTICATION_REQUIRED', 'Войдите в аккаунт.');
  }
  private async connection(db: PoolClient, user: string) {
    const r = await db.query(
      'SELECT s.id FROM training_students s JOIN trainer_profiles t ON t.user_id=s.trainer_id AND t.is_active WHERE s.client_id=$1 AND s.archived_at IS NULL FOR SHARE OF s,t',
      [user],
    );
    return r.rows[0]?.id as string | undefined;
  }
  public async list(user: string, recordedDate: unknown, student?: string) {
    const parsed = date.safeParse(recordedDate);
    if (!parsed.success) trainingError(400, 'INVALID_DATE', 'Выберите дату.');
    return this.service.transaction(async (db) => {
      if (student) await this.service.student(db, user, student);
      const rows = await db.query<NutritionEntry>(
        `SELECT ${columns} FROM nutrition_entries WHERE ${student ? 'student_id=$1 AND share_with_trainer' : 'client_id=$1'} AND recorded_date=$2 ORDER BY created_at,id LIMIT 30`,
        [student ?? user, parsed.data],
      );
      return { entries: rows.rows };
    });
  }
  public async save(user: string, id: string, body: unknown) {
    trainingId(id);
    const parsed = entry.safeParse(body);
    if (!parsed.success) trainingError(400, 'INVALID_MEAL', 'Укажите продукты, количество и дату.');
    const value = parsed.data;
    return this.service.transaction(async (db) => {
      await this.lockClient(db, user);
      const current = await db.query<
        NutritionEntry & { client_id: string; student_id: string | null }
      >(`SELECT ${columns},client_id,student_id FROM nutrition_entries WHERE id=$1 FOR UPDATE`, [
        id,
      ]);
      const old = current.rows[0];
      if (old && old.client_id !== user)
        trainingError(404, 'MEAL_UNAVAILABLE', 'Запись недоступна.');
      const fields = [
        'recorded_date',
        'slot',
        'title',
        'items',
        'note',
        'share_with_trainer',
      ] as const;
      if (old && fields.every((k) => isDeepStrictEqual(old[k], value[k])))
        return { id, revision: old.revision };
      if ((old?.revision ?? 0) !== value.revision)
        trainingError(409, 'MEAL_CHANGED', 'Запись изменилась. Откройте её заново.');
      const student = old?.student_id ?? (await this.connection(db, user));
      if (value.share_with_trainer && !student)
        trainingError(
          409,
          'TRAINER_NOT_CONNECTED',
          'Сначала подключитесь к тренеру или сохраните запись только для себя.',
        );
      const count = await db.query(
        'SELECT count(*)::integer n FROM nutrition_entries WHERE client_id=$1 AND recorded_date=$2 AND id<>$3',
        [user, value.recorded_date, id],
      );
      if (count.rows[0].n >= 30)
        trainingError(409, 'MEAL_LIMIT', 'На день можно сохранить до 30 приёмов пищи.');
      const args = [
        id,
        user,
        student ?? null,
        value.recorded_date,
        value.slot,
        value.title,
        JSON.stringify(value.items),
        value.note,
        value.share_with_trainer,
      ];
      const saved = old
        ? await db.query(
            'UPDATE nutrition_entries SET student_id=$3,recorded_date=$4,slot=$5,title=$6,items=$7::jsonb,note=$8,share_with_trainer=$9,revision=revision+1,updated_at=now() WHERE id=$1 AND client_id=$2 RETURNING revision',
            args,
          )
        : await db.query(
            'INSERT INTO nutrition_entries(id,client_id,student_id,recorded_date,slot,title,items,note,share_with_trainer) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING revision',
            args,
          );
      return { id, revision: saved.rows[0].revision as number };
    });
  }
  public async templates(user: string) {
    const r = await this.service.pool.query<NutritionTemplate>(
      'SELECT id,name,kind,meals FROM nutrition_templates WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100',
      [user],
    );
    return { templates: r.rows };
  }
  public async saveTemplate(user: string, id: string, body: unknown) {
    trainingId(id);
    const parsed = template.safeParse(body);
    if (!parsed.success)
      trainingError(400, 'INVALID_FOOD_TEMPLATE', 'Укажите название и состав шаблона.');
    return this.service.transaction(async (db) => {
      await this.lockClient(db, user);
      const existing = await db.query(
        'SELECT client_id,name,kind,meals FROM nutrition_templates WHERE id=$1',
        [id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].client_id !== user)
          trainingError(404, 'TEMPLATE_UNAVAILABLE', 'Шаблон недоступен.');
        if (
          !['name', 'kind', 'meals'].every((k) =>
            isDeepStrictEqual(existing.rows[0][k], parsed.data[k as keyof typeof parsed.data]),
          )
        )
          trainingError(409, 'TEMPLATE_CHANGED', 'Сохраните изменения как новый шаблон.');
        return { id };
      }
      const count = await db.query(
        'SELECT count(*)::integer n FROM nutrition_templates WHERE client_id=$1',
        [user],
      );
      if (count.rows[0].n >= 100)
        trainingError(409, 'TEMPLATE_LIMIT', 'Удалите ненужные шаблоны: доступно до 100.');
      await db.query(
        'INSERT INTO nutrition_templates(id,client_id,name,kind,meals) VALUES($1,$2,$3,$4,$5::jsonb)',
        [id, user, parsed.data.name, parsed.data.kind, JSON.stringify(parsed.data.meals)],
      );
      return { id };
    });
  }
  public async removeTemplate(user: string, id: string) {
    const r = await this.service.pool.query(
      'DELETE FROM nutrition_templates WHERE id=$1 AND client_id=$2',
      [trainingId(id), user],
    );
    if (r.rowCount !== 1) trainingError(404, 'TEMPLATE_UNAVAILABLE', 'Шаблон недоступен.');
    return { removed: true };
  }
  public async apply(user: string, templateId: string, body: unknown) {
    trainingId(templateId);
    const parsed = z
      .object({ request_id: uuid, recorded_date: date, share_with_trainer: z.boolean() })
      .strict()
      .safeParse(body);
    if (!parsed.success) trainingError(400, 'INVALID_TEMPLATE_DATE', 'Выберите дату для рациона.');
    const value = parsed.data;
    return this.service.transaction(async (db) => {
      await this.lockClient(db, user);
      const previous = await db.query(
        'SELECT template_id,recorded_date::text,share_with_trainer,entry_ids FROM nutrition_template_applications WHERE client_id=$1 AND request_id=$2',
        [user, value.request_id],
      );
      if (previous.rows[0]) {
        const old = previous.rows[0];
        if (
          old.template_id !== templateId ||
          old.recorded_date !== value.recorded_date ||
          old.share_with_trainer !== value.share_with_trainer
        )
          trainingError(409, 'TEMPLATE_CHANGED', 'Повторите применение рациона.');
        return { ids: old.entry_ids as string[] };
      }
      const r = await db.query<NutritionTemplate>(
        'SELECT id,name,kind,meals FROM nutrition_templates WHERE id=$1 AND client_id=$2',
        [templateId, user],
      );
      const saved = r.rows[0];
      if (!saved) trainingError(404, 'TEMPLATE_UNAVAILABLE', 'Шаблон недоступен.');
      const student = await this.connection(db, user);
      if (value.share_with_trainer && !student)
        trainingError(409, 'TRAINER_NOT_CONNECTED', 'Сначала подключитесь к тренеру.');
      const count = await db.query(
        'SELECT count(*)::integer n FROM nutrition_entries WHERE client_id=$1 AND recorded_date=$2',
        [user, value.recorded_date],
      );
      if (count.rows[0].n + saved.meals.length > 30)
        trainingError(409, 'MEAL_LIMIT', 'В этот день слишком много записей.');
      const ids: string[] = [];
      for (const meal of saved.meals) {
        const id = randomUUID();
        ids.push(id);
        await db.query(
          'INSERT INTO nutrition_entries(id,client_id,student_id,recorded_date,slot,title,items,share_with_trainer) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
          [
            id,
            user,
            student ?? null,
            value.recorded_date,
            meal.slot,
            meal.title,
            JSON.stringify(meal.items),
            value.share_with_trainer,
          ],
        );
      }
      await db.query(
        'INSERT INTO nutrition_template_applications(client_id,request_id,template_id,recorded_date,share_with_trainer,entry_ids) VALUES($1,$2,$3,$4,$5,$6)',
        [user, value.request_id, templateId, value.recorded_date, value.share_with_trainer, ids],
      );
      return { ids };
    });
  }
}
