import { canonicalizeChatTextValue } from '@kinetra/shared';
import { z } from 'zod';

import { HttpError } from '../auth/errors.js';

export const uuidSchema = z.string().uuid();

export const emptyObjectSchema = z.object({}).strict();

const textMessageSchema = z
  .object({
    client_message_id: uuidSchema,
    kind: z.literal('text'),
    text: z.string(),
  })
  .strict();

const photoMessageSchema = z
  .object({
    client_message_id: uuidSchema,
    kind: z.literal('photo'),
    text: z.string().nullable().optional(),
    photo_id: uuidSchema,
  })
  .strict();

export const sendMessageSchema = z.discriminatedUnion('kind', [
  textMessageSchema,
  photoMessageSchema,
]);

export const readUpdateSchema = z
  .object({
    through_sequence: z.number().int().nonnegative().safe(),
  })
  .strict();

const integerQuery = z
  .string()
  .regex(/^\d+$/u)
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());

export const messageListQuerySchema = z
  .object({
    before_sequence: integerQuery.optional(),
    after_sequence: integerQuery.optional(),
    limit: integerQuery.pipe(z.number().int().min(1).max(50)).optional(),
  })
  .strict()
  .refine(
    (query) => query.before_sequence === undefined || query.after_sequence === undefined,
    'before_sequence and after_sequence cannot be combined.',
  );

export const conversationListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(2048).optional(),
    limit: integerQuery.pipe(z.number().int().min(1).max(50)).optional(),
    filter: z.enum(['all', 'unread']).optional(),
    query: z.string().optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    filter: value.filter ?? ('all' as const),
    limit: value.limit ?? 30,
    query: value.query?.normalize('NFC').trim() || null,
  }))
  .refine(
    (value) => value.query === null || (value.query.length >= 2 && value.query.length <= 100),
    'query must contain between 2 and 100 characters.',
  );

const cursorPayloadSchema = z
  .object({
    v: z.literal(1),
    activity_at: z.string().datetime({ offset: true }),
    conversation_id: uuidSchema,
    filter: z.enum(['all', 'unread']),
    query: z.string().nullable(),
  })
  .strict();

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;
export type ChatCursorPayload = z.infer<typeof cursorPayloadSchema>;

export const parseCursorPayload = (value: unknown): ChatCursorPayload => {
  const parsed = cursorPayloadSchema.safeParse(value);

  if (!parsed.success) {
    throw new HttpError(400, 'CHAT_INVALID_REQUEST', 'The chat cursor is invalid.');
  }

  return parsed.data;
};

export const canonicalizeChatText = (
  rawValue: string | null | undefined,
  maximumCodePoints: number,
  optional: boolean,
): string | null => {
  if (rawValue === null || rawValue === undefined) {
    if (optional) {
      return null;
    }

    throw new HttpError(422, 'CHAT_MESSAGE_INVALID', 'Message text is required.');
  }

  const canonical = canonicalizeChatTextValue(rawValue);

  if (canonical.hasForbiddenControl) {
    throw new HttpError(
      422,
      'CHAT_MESSAGE_INVALID',
      'Message text contains unsupported control characters.',
    );
  }

  if (canonical.codePointLength === 0) {
    if (optional) {
      return null;
    }

    throw new HttpError(422, 'CHAT_MESSAGE_INVALID', 'Message text cannot be blank.');
  }

  if (canonical.codePointLength > maximumCodePoints) {
    throw new HttpError(
      422,
      'CHAT_MESSAGE_INVALID',
      `Message text cannot exceed ${maximumCodePoints} Unicode characters.`,
    );
  }

  return canonical.value;
};

export const parseStrictly = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new HttpError(
      400,
      'CHAT_INVALID_REQUEST',
      parsed.error.issues[0]?.message ?? 'The chat request is invalid.',
    );
  }

  return parsed.data;
};
