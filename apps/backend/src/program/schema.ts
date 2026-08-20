import { z } from 'zod';

import { PROGRAM_WEEK_COUNT } from './repository.js';

export const programWeekNumberSchema = z.coerce
  .number()
  .int('Week number must be an integer.')
  .min(1, 'Week number must be at least 1.')
  .max(PROGRAM_WEEK_COUNT, `Week number must not exceed ${PROGRAM_WEEK_COUNT}.`);

export const workoutCompletionSchema = z
  .object({
    video_id: z.uuid('Video identifier must be a valid UUID.'),
    program_week: z
      .number()
      .int('Program week must be an integer.')
      .min(1, 'Program week must be at least 1.')
      .max(PROGRAM_WEEK_COUNT, `Program week must not exceed ${PROGRAM_WEEK_COUNT}.`),
  })
  .strict();
