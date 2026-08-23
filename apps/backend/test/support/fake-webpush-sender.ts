import type { PushDeviceSubscription, PushSendResult } from '../../src/push/repository.js';
import type { PushPayload, PushSender } from '../../src/push/webpush-sender.js';

export interface CapturedPush {
  readonly endpoint: string;
  readonly payload: PushPayload;
}

export class FakePushSender implements PushSender {
  public readonly sent: CapturedPush[] = [];
  private readonly outcomes = new Map<string, PushSendResult>();

  public async send(
    subscription: PushDeviceSubscription,
    payload: PushPayload,
  ): Promise<PushSendResult> {
    this.sent.push({ endpoint: subscription.endpoint, payload: { ...payload } });
    return this.outcomes.get(subscription.endpoint) ?? { kind: 'sent' };
  }

  public setOutcome(endpoint: string, outcome: PushSendResult): void {
    this.outcomes.set(endpoint, outcome);
  }
}
