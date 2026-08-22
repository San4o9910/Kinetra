import { randomUUID } from 'node:crypto';

import type {
  RenewalFailureNotification,
  RenewalFailureNotifier,
} from '../../src/payments/renewal-service.js';
import type { YooKassaPayment, YooKassaRefund } from '../../src/payments/schema.js';
import type {
  YooKassaClient,
  YooKassaCreatePaymentInput,
} from '../../src/payments/yookassa-client.js';
import type { WebhookSourceVerifier } from '../../src/payments/webhook-source.js';

export interface CapturedCreatePayment {
  readonly input: YooKassaCreatePaymentInput;
  readonly idempotencyKey: string;
}

type FakePaymentFactory = (
  input: YooKassaCreatePaymentInput,
  idempotencyKey: string,
) => YooKassaPayment | Promise<YooKassaPayment>;
type AfterCreatePaymentHook = (payment: YooKassaPayment) => Promise<void>;

export class FakeYooKassaClient implements YooKassaClient {
  public readonly created: CapturedCreatePayment[] = [];
  private readonly payments = new Map<string, YooKassaPayment>();
  private readonly refunds = new Map<string, YooKassaRefund>();
  private nextPayment:
    YooKassaPayment | Promise<YooKassaPayment> | FakePaymentFactory | Error | null = null;
  private afterCreatePayment: AfterCreatePaymentHook | null = null;

  public async createPayment(
    input: YooKassaCreatePaymentInput,
    idempotencyKey: string,
  ): Promise<YooKassaPayment> {
    this.created.push({ input, idempotencyKey });
    const configured = this.nextPayment;
    this.nextPayment = null;

    if (configured instanceof Error) {
      throw configured;
    }

    const payment =
      configured === null
        ? ({
            id: randomUUID(),
            status: 'pending',
            paid: false,
            amount: { ...input.amount },
            confirmation: {
              type: 'redirect',
              confirmation_url: `https://yookassa.test/checkout/${idempotencyKey}`,
            },
            metadata: { ...input.metadata },
          } satisfies YooKassaPayment)
        : typeof configured === 'function'
          ? await configured(input, idempotencyKey)
          : await configured;
    this.payments.set(payment.id, payment);
    const afterCreatePayment = this.afterCreatePayment;
    this.afterCreatePayment = null;

    if (afterCreatePayment !== null) {
      await afterCreatePayment(payment);
    }

    return payment;
  }

  public async getPayment(paymentId: string): Promise<YooKassaPayment> {
    const payment = this.payments.get(paymentId);

    if (payment === undefined) {
      throw new Error(`Fake YooKassa payment ${paymentId} was not found.`);
    }

    return payment;
  }

  public async getRefund(refundId: string): Promise<YooKassaRefund> {
    const refund = this.refunds.get(refundId);

    if (refund === undefined) {
      throw new Error(`Fake YooKassa refund ${refundId} was not found.`);
    }

    return refund;
  }

  public configureNextPayment(
    payment: YooKassaPayment | Promise<YooKassaPayment> | FakePaymentFactory | Error,
  ): void {
    this.nextPayment = payment;
  }

  public seedPayment(payment: YooKassaPayment): void {
    this.payments.set(payment.id, payment);
  }

  public seedRefund(refund: YooKassaRefund): void {
    this.refunds.set(refund.id, refund);
  }

  public setAfterCreatePayment(hook: AfterCreatePaymentHook): void {
    this.afterCreatePayment = hook;
  }
}

export class FixedWebhookSourceVerifier implements WebhookSourceVerifier {
  public constructor(private allowed: boolean) {}

  public isAllowed(): boolean {
    return this.allowed;
  }

  public setAllowed(allowed: boolean): void {
    this.allowed = allowed;
  }
}

export class FakeRenewalFailureNotifier implements RenewalFailureNotifier {
  public readonly notifications: RenewalFailureNotification[] = [];

  public async notifyRenewalFailure(notification: RenewalFailureNotification): Promise<void> {
    this.notifications.push(notification);
  }
}
