import { z } from 'zod';

export const workoutKeySchema = z
  .object({ video_id: z.string().uuid(), program_week: z.coerce.number().int().min(1).max(12) })
  .strict();
export const workoutSessionSchema = z
  .object({
    position_seconds: z.number().int().min(0).max(86400).optional(),
    difficulty: z.number().int().min(1).max(5).optional(),
    wellbeing: z.number().int().min(1).max(5).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Изменения не указаны.');
export const workoutGuideSchema = z
  .object({
    equipment: z.array(z.string().trim().min(1).max(100)).max(20),
    technique: z.string().trim().max(5000),
    chapters: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            start_seconds: z.number().int().min(0).max(86400),
          })
          .strict(),
      )
      .max(50),
  })
  .strict()
  .refine(
    (guide) =>
      guide.chapters.every(
        (chapter, index) =>
          index === 0 || chapter.start_seconds > guide.chapters[index - 1]!.start_seconds,
      ),
    'Разделы должны идти по времени без повторов.',
  );
export const coachQuestionSchema = z
  .object({
    request_id: z.string().uuid(),
    question: z.string().trim().min(1).max(2000),
    use_progress: z.boolean().default(false),
  })
  .strict();
