import { z } from 'zod';

import { HttpError } from '../auth/errors.js';

export const uuidSchema = z.string().uuid();
export const emptyObjectSchema = z.object({}).strict();
export const weekSchema = z.coerce.number().int().min(1).max(12);
export const daySchema = z.coerce.number().int().min(1).max(7);

export const createUploadSchema = z
  .object({
    week_number: z.number().int().min(1).max(12),
    day_of_week: z.number().int().min(1).max(7),
    mime_type: z.literal('video/mp4'),
    size_bytes: z.number().int().positive().max(2_147_483_648),
  })
  .strict();

const canonicalSha256Base64 = z
  .string()
  .length(44)
  .regex(/^[A-Za-z0-9+/]{43}=$/u, 'Checksum must be canonical base64 SHA-256.')
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 && decoded.toString('base64') === value;
  }, 'Checksum must be canonical base64 SHA-256.');

export const signPartsSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            part_number: z.number().int().min(1).max(10_000),
            checksum_sha256: canonicalSha256Base64,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .superRefine(({ parts }, context) => {
    if (new Set(parts.map((part) => part.part_number)).size !== parts.length) {
      context.addIssue({ code: 'custom', message: 'Part numbers must be unique.' });
    }
  });

export const parseVideoInput = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'VIDEO_UPLOAD_INVALID_REQUEST',
      parsed.error.issues[0]?.message ?? 'Video upload request is invalid.',
    );
  }
  return parsed.data;
};
