import { z } from 'zod';

export const createPaymentRequestSchema = z
  .object({
    return_url: z.string().url().max(2_048),
  })
  .strict();

export const subscriptionMetadataSchema = z
  .object({
    user_id: z.string().uuid(),
    subscription_id: z.string().uuid(),
    attempt_id: z.string().uuid(),
    type: z.literal('subscription'),
  })
  .passthrough();

export const yooKassaAmountSchema = z
  .object({
    value: z.string().regex(/^\d+\.\d{2}$/u),
    currency: z.string().length(3),
  })
  .passthrough();

export const yooKassaPaymentSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['pending', 'waiting_for_capture', 'succeeded', 'canceled']),
    paid: z.boolean().optional(),
    amount: yooKassaAmountSchema,
    confirmation: z
      .object({
        type: z.string(),
        confirmation_url: z.string().url().optional(),
      })
      .passthrough()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    payment_method: z
      .object({
        id: z.string().min(1),
        saved: z.boolean(),
      })
      .passthrough()
      .optional(),
    refunded_amount: yooKassaAmountSchema.optional(),
  })
  .passthrough();

export const yooKassaRefundSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['pending', 'succeeded', 'canceled']),
    payment_id: z.string().min(1),
    amount: yooKassaAmountSchema,
  })
  .passthrough();

export const webhookNotificationSchema = z
  .object({
    type: z.literal('notification'),
    event: z.enum(['payment.succeeded', 'payment.canceled', 'refund.succeeded']),
    object: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export type YooKassaPayment = z.infer<typeof yooKassaPaymentSchema>;
export type YooKassaRefund = z.infer<typeof yooKassaRefundSchema>;
export type WebhookNotification = z.infer<typeof webhookNotificationSchema>;
