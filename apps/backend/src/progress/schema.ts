import { z } from 'zod';

import { surveyGoalSchema } from '../profile/schema.js';

const metricScoreSchema = z.number().int().min(1).max(10);

export const weeklyMetricsSchema = z
  .object({
    program_week: z.number().int().min(1).max(12),
    energy: metricScoreSchema,
    sleep: metricScoreSchema,
    mood: metricScoreSchema,
    body_satisfaction: metricScoreSchema,
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export const progressGoalSchema = z
  .object({
    goal: surveyGoalSchema,
  })
  .strict();
