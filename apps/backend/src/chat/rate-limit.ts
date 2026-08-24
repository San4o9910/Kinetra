import { HttpError } from '../auth/errors.js';

export type ChatRateScope =
  | 'history'
  | 'message'
  | 'photo_bytes_hour'
  | 'photo_hour'
  | 'photo_minute'
  | 'trainer_search'
  | 'websocket_handshake';

export interface ChatRateLimitInput {
  readonly scope: ChatRateScope;
  readonly key: string;
  readonly maximum: number;
  readonly windowMs: number;
  readonly cost?: number;
}

export interface ChatRateLimiter {
  consume(input: ChatRateLimitInput): void;
}

interface Counter {
  count: number;
  expiresAt: number;
}

export class InMemoryChatRateLimiter implements ChatRateLimiter {
  private readonly counters = new Map<string, Counter>();
  private lastSweepAt = 0;

  public consume(input: ChatRateLimitInput): void {
    const now = Date.now();

    if (now - this.lastSweepAt >= 60_000) {
      for (const [key, counter] of this.counters) {
        if (counter.expiresAt <= now) {
          this.counters.delete(key);
        }
      }

      this.lastSweepAt = now;
    }

    const counterKey = `${input.scope}:${input.key}`;
    const current = this.counters.get(counterKey);
    const counter =
      current === undefined || current.expiresAt <= now
        ? { count: 0, expiresAt: now + input.windowMs }
        : current;
    counter.count += input.cost ?? 1;
    this.counters.set(counterKey, counter);

    if (counter.count > input.maximum) {
      throw new HttpError(429, 'CHAT_RATE_LIMITED', 'Too many chat requests. Try again later.');
    }
  }
}

export class NoopChatRateLimiter implements ChatRateLimiter {
  public consume(_input: ChatRateLimitInput): void {}
}
