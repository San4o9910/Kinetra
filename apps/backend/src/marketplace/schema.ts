import { z } from 'zod';
import { MARKET_DISCIPLINES } from '@kinetra/shared';
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const marketProfileSchema = z
  .object({
    display_name: text(1, 120),
    headline: text(1, 160),
    bio: text(1, 5000),
    city: text(0, 120),
    approach: text(1, 3000),
    disciplines: z
      .array(z.enum(MARKET_DISCIPLINES))
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length),
    languages: z
      .array(text(2, 40))
      .min(1)
      .max(5)
      .refine((v) => new Set(v).size === v.length),
    faq: z.array(z.object({ question: text(1, 200), answer: text(1, 1500) }).strict()).max(10),
  })
  .strict();
const offerFields = z
  .object({
    title: text(1, 160),
    summary: text(1, 300),
    description: text(1, 5000),
    discipline: z.enum(MARKET_DISCIPLINES),
    kind: z.enum(['program', 'coaching', 'club', 'lesson']),
    level: z.enum(['beginner', 'intermediate', 'advanced', 'all']),
    price_kopecks: z.number().int().min(100).max(100_000_000),
    payment_period: z.enum(['once', 'month']),
    access_days: z.number().int().min(1).max(730),
    start_policy: text(1, 500),
    includes: text(1, 3000),
    requirements: text(1, 2000),
    feedback: text(1, 2000),
    nutrition: z.enum(['none', 'general', 'personal']),
    response_hours: z.number().int().min(1).max(336).nullable(),
    video_reviews: z.number().int().min(0).max(100),
    meetings: z.number().int().min(0).max(100),
    capacity: z.number().int().min(1).max(500).nullable(),
    application_required: z.boolean(),
    cancellation_terms: text(1, 3000),
    sample_text: text(0, 5000),
  })
  .strict();
export const marketProfileDraftSchema = marketProfileSchema.extend({
  headline: text(0, 160),
  bio: text(0, 5000),
  approach: text(0, 3000),
});
export const marketOfferDraftSchema = offerFields.extend({
  summary: text(0, 300),
  description: text(0, 5000),
  price_kopecks: z.number().int().min(0).max(100_000_000),
  start_policy: text(0, 500),
  includes: text(0, 3000),
  requirements: text(0, 2000),
  feedback: text(0, 2000),
  cancellation_terms: text(0, 3000),
});
export const marketOfferSchema = offerFields.superRefine((v, ctx) => {
  if ((v.kind === 'coaching' || v.kind === 'club') !== (v.payment_period === 'month'))
    ctx.addIssue({
      code: 'custom',
      path: ['payment_period'],
      message: 'Сопровождение и клуб оплачиваются помесячно; программа и занятия — разово.',
    });
  if (v.kind === 'coaching' && (v.response_hours === null || v.capacity === null))
    ctx.addIssue({
      code: 'custom',
      path: ['capacity'],
      message: 'Укажите срок ответа и число мест для личного сопровождения.',
    });
});
export const marketRevisionSchema = z.object({ revision: z.number().int().positive() }).strict();
export const marketReviewSchema = marketRevisionSchema
  .extend({
    action: z.enum(['approve', 'request_changes', 'suspend']),
    note: text(0, 2000),
  })
  .strict()
  .refine((v) => v.action === 'approve' || v.note.length > 0, 'Укажите причину решения.');
export const marketQuerySchema = z
  .object({
    q: text(0, 100).default(''),
    discipline: z.enum(MARKET_DISCIPLINES).optional(),
    kind: z.enum(['program', 'coaching', 'club', 'lesson']).optional(),
    level: z.enum(['beginner', 'intermediate', 'advanced', 'all']).optional(),
    period: z.enum(['once', 'month']).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
  })
  .strict();
