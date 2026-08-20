import type { Clock } from '../../src/auth/service.js';

export class MutableClock implements Clock {
  public constructor(private current: Date) {}

  public now(): Date {
    return new Date(this.current.getTime());
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
