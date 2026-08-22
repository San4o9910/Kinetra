import type { SubscriptionAccessChecker } from '../../src/payments/subscription-access.js';

export class FakeSubscriptionAccessChecker implements SubscriptionAccessChecker {
  public constructor(private active = true) {}

  public async hasActiveSubscription(): Promise<boolean> {
    return this.active;
  }

  public setActive(active: boolean): void {
    this.active = active;
  }
}
