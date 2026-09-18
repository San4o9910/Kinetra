import { z } from 'zod';
export const uuid = z.string().uuid();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const studentSchema = z
  .object({ name: text(1, 120), contact: text(0, 200).default('') })
  .strict();
export const inviteSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict();
const date = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}$/u)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Некорректная дата');
export const planSchema = z
  .object({
    title: text(1, 160),
    goal: text(0, 2000).default(''),
    revision: z.number().int().positive(),
    workouts: z
      .array(
        z
          .object({
            id: uuid,
            title: text(1, 160),
            instructions: text(0, 5000).default(''),
            scheduled_date: date.nullable(),
            duration_minutes: z.number().int().min(1).max(240),
            lesson_id: uuid.nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .refine((v) => new Set(v.workouts.map((w) => w.id)).size === v.workouts.length);
export const lessonSchema = z
  .object({
    title: text(1, 160),
    description: text(0, 5000).default(''),
    size_bytes: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024 * 1024),
  })
  .strict();
export const logSchema = z
  .object({
    completed: z.literal(true).optional(),
    position_seconds: z.number().int().min(0).max(7200).optional(),
    difficulty: z.number().int().min(1).max(5).optional(),
    wellbeing: z.number().int().min(1).max(5).optional(),
    note: text(0, 1000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
