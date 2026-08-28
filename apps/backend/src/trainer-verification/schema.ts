import { z } from 'zod';

const containsNoControlCharacters = (value: string): boolean =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
  });
const trimmedText = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine(containsNoControlCharacters, 'Control characters are not allowed.')
    .transform((value) => value.normalize('NFC'));

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Date must use YYYY-MM-DD.')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Date is invalid.');

const timezoneSchema = trimmedText(1, 64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, 'timezone must be a valid IANA time zone.');

const httpsUrlSchema = z
  .string()
  .trim()
  .min(9)
  .max(2048)
  .transform((value, context) => {
    try {
      const url = new URL(value);

      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
        context.addIssue({
          code: 'custom',
          message: 'Material URL must be HTTPS and must not contain credentials.',
        });
        return z.NEVER;
      }

      return url.toString();
    } catch {
      context.addIssue({ code: 'custom', message: 'Material URL is invalid.' });
      return z.NEVER;
    }
  });

export const trainerVerificationMaterialKindSchema = z.enum([
  'professional_profile',
  'certificate',
  'diploma',
  'portfolio',
  'other',
]);

export const trainerVerificationApplicationSchema = z
  .object({
    display_name: trimmedText(1, 120),
    specialization: trimmedText(1, 160),
    experience_years: z.number().int().min(0).max(80),
    bio: trimmedText(20, 2000),
    city: trimmedText(1, 120),
    timezone: timezoneSchema,
    materials: z
      .array(
        z
          .object({
            kind: trainerVerificationMaterialKindSchema,
            url: httpsUrlSchema,
            title: trimmedText(1, 160),
            issued_at: calendarDateSchema.optional(),
            expires_at: calendarDateSchema.optional(),
          })
          .strict()
          .superRefine((material, context) => {
            if (
              material.issued_at !== undefined &&
              material.expires_at !== undefined &&
              material.expires_at < material.issued_at
            ) {
              context.addIssue({
                code: 'custom',
                path: ['expires_at'],
                message: 'expires_at cannot be earlier than issued_at.',
              });
            }
          }),
      )
      .min(1, 'At least one verification material is required.')
      .max(20)
      .refine(
        (materials) => new Set(materials.map((material) => material.url)).size === materials.length,
        {
          message: 'Material URLs must be unique.',
        },
      ),
  })
  .strict();

export const trainerVerificationReviewSchema = z
  .object({
    reason: trimmedText(1, 1000).optional(),
  })
  .strict();

export const trainerVerificationRequiredReviewSchema = trainerVerificationReviewSchema.refine(
  (review) => review.reason !== undefined,
  { path: ['reason'], message: 'A review reason is required.' },
);

export const trainerVerificationStatusFilterSchema = z.enum([
  'pending',
  'needs_more_info',
  'approved',
  'rejected',
  'withdrawn',
]);

export const trainerVerificationRequestIdSchema = z.string().uuid();

export type ValidatedTrainerVerificationApplication = z.infer<
  typeof trainerVerificationApplicationSchema
>;
