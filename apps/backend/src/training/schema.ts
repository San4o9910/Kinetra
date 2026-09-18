import { z } from 'zod';
export const uuid = z.string().uuid();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const studentSchema = z
  .object({ name: text(1, 120), contact: text(0, 200).default('') })
  .strict();
export const inviteSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict();
export const date = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}$/u)
  .refine((v) => {
    const d = new Date(`${v}T12:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Некорректная дата');
export const exerciseSchema = z
  .object({
    id: uuid,
    name: text(1, 160),
    sets: z.number().int().min(1).max(20),
    repetitions: z.number().int().min(1).max(1000).nullable(),
    seconds: z.number().int().min(1).max(7200).nullable(),
    weight_kg: z.number().min(0).max(1000).nullable(),
    rest_seconds: z.number().int().min(0).max(1800),
    lesson_id: uuid.nullable(),
  })
  .strict()
  .refine((v) => v.repetitions !== null || v.seconds !== null);
export const setRecordSchema = z
  .object({
    exercise_id: uuid,
    set: z.number().int().min(1).max(20),
    repetitions: z.number().int().min(0).max(1000).nullable(),
    seconds: z.number().int().min(0).max(7200).nullable(),
    weight_kg: z.number().min(0).max(1000).nullable(),
    completed: z.boolean(),
  })
  .strict();
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
            exercises: z
              .array(exerciseSchema)
              .max(40)
              .default([])
              .refine((v) => new Set(v.map((e) => e.id)).size === v.length),
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
    folder: text(0, 80).default(''),
    original_name: text(0, 200).default(''),
    source_modified: z.number().int().min(0).max(9999999999999).nullable().default(null),
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
    base_revision: z.number().int().min(0).optional(),
    set_records: z
      .array(setRecordSchema)
      .max(800)
      .refine((v) => new Set(v.map((r) => `${r.exercise_id}:${r.set}`)).size === v.length)
      .optional(),
    position_seconds: z.number().int().min(0).max(7200).optional(),
    difficulty: z.number().int().min(1).max(5).optional(),
    wellbeing: z.number().int().min(1).max(5).optional(),
    note: text(0, 1000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);

export const measurementSchema = z
  .object({
    recorded_date: date,
    weight_kg: z.number().min(20).max(400).nullable(),
    waist_cm: z.number().min(20).max(300).nullable(),
    chest_cm: z.number().min(20).max(300).nullable(),
    hips_cm: z.number().min(20).max(300).nullable(),
    note: text(0, 1000).default(''),
    share_with_trainer: z.boolean(),
  })
  .strict();
export const rescheduleSchema = z
  .object({ requested_date: date, reason: text(0, 1000).default('') })
  .strict();
export const complaintSchema = z.object({ reason: text(10, 2000) }).strict();
export const complaintReviewSchema = z
  .object({
    status: z.enum(['reviewing', 'resolved']),
    resolution: text(1, 2000),
    revision: z.number().int().positive(),
  })
  .strict();
