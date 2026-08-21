import { z } from 'zod';

const reminderTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, 'reminder_time must use 24-hour HH:MM format.');

export const notificationPreferencesSchema = z
  .object({
    workout_reminders: z.boolean(),
    reminder_time: reminderTimeSchema,
    weekly_survey_reminder: z.boolean(),
  })
  .strict();

export const deleteAccountSchema = z
  .object({
    confirm: z.literal('DELETE'),
  })
  .strict();
