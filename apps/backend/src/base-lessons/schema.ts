import { z } from 'zod';

const completionPercentSchema = z
  .number()
  .finite()
  .min(0, 'completion_percent must be at least 0.')
  .max(100, 'completion_percent must be at most 100.')
  .transform((value) => Math.round((value + Number.EPSILON) * 100) / 100);

export const lessonIdSchema = z.string().uuid('lessonId must be a valid UUID.');

export const lessonProgressSchema = z
  .object({
    position_seconds: z
      .number()
      .finite()
      .int('position_seconds must be an integer.')
      .min(0, 'position_seconds must be at least 0.')
      .max(2_147_483_647, 'position_seconds exceeds the supported range.'),
    completion_percent: completionPercentSchema,
  })
  .strict();

export type ValidatedLessonProgress = z.output<typeof lessonProgressSchema>;
