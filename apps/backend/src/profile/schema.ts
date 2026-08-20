import { z } from 'zod';

export const surveyGenderSchema = z.enum(['male', 'female']);
export const surveyAgeRangeSchema = z.enum(['18-25', '26-35', '36-45', '46-55', '55+']);
export const surveyGoalSchema = z.enum([
  'flexibility',
  'strength',
  'awareness',
  'general_health',
]);
export const surveyInjurySchema = z.enum([
  'none',
  'knees',
  'lower_back',
  'shoulders',
  'neck',
  'other',
]);
export const surveyExperienceSchema = z.enum(['beginner', 'novice', 'experienced']);

export const surveySubmissionSchema = z
  .object({
    gender: surveyGenderSchema,
    age_range: surveyAgeRangeSchema,
    goal: surveyGoalSchema,
    injuries: z
      .array(surveyInjurySchema)
      .min(1, 'Choose at least one injury option.')
      .max(6)
      .refine((injuries) => new Set(injuries).size === injuries.length, {
        message: 'Injury options must be unique.',
      }),
    injuries_detail: z.string().trim().min(1).max(500).optional(),
    experience: surveyExperienceSchema,
  })
  .strict()
  .superRefine((survey, context) => {
    if (survey.injuries.includes('none') && survey.injuries.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['injuries'],
        message: '"none" cannot be combined with other injury options.',
      });
    }

    if (survey.injuries.includes('other') && survey.injuries_detail === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['injuries_detail'],
        message: 'Describe the other injury or limitation.',
      });
    }

    if (!survey.injuries.includes('other') && survey.injuries_detail !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['injuries_detail'],
        message: 'injuries_detail is allowed only when "other" is selected.',
      });
    }
  });

export type ValidatedSurveySubmission = z.infer<typeof surveySubmissionSchema>;
