import type { ChatConversationStateDto, ChatReadResultDto } from './types';

export const CHAT_READ_DEBOUNCE_MS = 250;
export const CHAT_READ_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

export interface ChatReadAcknowledgementScheduler {
  readonly setTimer: (callback: () => void, delayMilliseconds: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
}

export interface ChatReadAcknowledgementLifecycleOptions {
  readonly markRead: (throughSequence: number, signal: AbortSignal) => Promise<ChatReadResultDto>;
  readonly onAcknowledged: (state: ChatConversationStateDto) => void;
  readonly onTerminalError: (error: unknown) => void;
  readonly isTerminalError: (error: unknown) => boolean;
  readonly scheduler?: ChatReadAcknowledgementScheduler;
}

const browserScheduler: ChatReadAcknowledgementScheduler = {
  setTimer: (callback, delayMilliseconds) => globalThis.setTimeout(callback, delayMilliseconds),
  clearTimer: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
};

export class ChatReadAcknowledgementLifecycle {
  private readonly options: ChatReadAcknowledgementLifecycleOptions;
  private readonly scheduler: ChatReadAcknowledgementScheduler;
  private acknowledgedSequence: number;
  private pendingSequence: number | null = null;
  private activeController: AbortController | null = null;
  private retryTimer: unknown | null = null;
  private retryAttempt = 0;
  private disposed = false;

  public constructor(options: ChatReadAcknowledgementLifecycleOptions, acknowledgedSequence = 0) {
    this.options = options;
    this.scheduler = options.scheduler ?? browserScheduler;
    this.acknowledgedSequence = acknowledgedSequence;
  }

  public get pendingThroughSequence(): number | null {
    return this.pendingSequence;
  }

  public queue(throughSequence: number): void {
    if (this.disposed || throughSequence <= this.acknowledgedSequence) {
      return;
    }

    const advanced = this.pendingSequence === null || throughSequence > this.pendingSequence;
    this.pendingSequence = Math.max(this.pendingSequence ?? 0, throughSequence);

    if (this.activeController !== null || this.retryTimer !== null) {
      return;
    }

    if (advanced) {
      this.retryAttempt = 0;
    }
    this.schedule(CHAT_READ_DEBOUNCE_MS);
  }

  public observeAcknowledged(throughSequence: number): void {
    this.acknowledgedSequence = Math.max(this.acknowledgedSequence, throughSequence);
    if (this.pendingSequence !== null && this.pendingSequence <= this.acknowledgedSequence) {
      this.pendingSequence = null;
      this.retryAttempt = 0;
      this.clearRetryTimer();
    }
  }

  public retryNow(): void {
    if (
      this.disposed ||
      this.pendingSequence === null ||
      this.pendingSequence <= this.acknowledgedSequence
    ) {
      return;
    }

    this.retryAttempt = 0;
    this.clearRetryTimer();
    this.startRequest();
  }

  public dispose(): void {
    this.disposed = true;
    this.pendingSequence = null;
    this.clearRetryTimer();
    this.activeController?.abort();
    this.activeController = null;
  }

  private schedule(delayMilliseconds: number): void {
    if (this.disposed || this.retryTimer !== null || this.pendingSequence === null) {
      return;
    }

    this.retryTimer = this.scheduler.setTimer(() => {
      this.retryTimer = null;
      this.startRequest();
    }, delayMilliseconds);
  }

  private startRequest(): void {
    if (
      this.disposed ||
      this.activeController !== null ||
      this.pendingSequence === null ||
      this.pendingSequence <= this.acknowledgedSequence
    ) {
      return;
    }

    const throughSequence = this.pendingSequence;
    const controller = new AbortController();
    this.activeController = controller;
    let acknowledged = false;

    void this.options
      .markRead(throughSequence, controller.signal)
      .then(({ conversation_state: state }) => {
        if (this.disposed || controller.signal.aborted) {
          return;
        }

        acknowledged = true;
        this.retryAttempt = 0;
        this.options.onAcknowledged(state);
        this.observeAcknowledged(state.own_last_read_sequence);
      })
      .catch((error: unknown) => {
        if (this.disposed || controller.signal.aborted) {
          return;
        }

        if (this.options.isTerminalError(error)) {
          this.pendingSequence = null;
          this.clearRetryTimer();
          this.options.onTerminalError(error);
          return;
        }

        if (this.retryAttempt < CHAT_READ_RETRY_DELAYS_MS.length) {
          const delay = CHAT_READ_RETRY_DELAYS_MS[this.retryAttempt]!;
          this.retryAttempt += 1;
          this.schedule(delay);
        }
      })
      .finally(() => {
        if (this.activeController === controller) {
          this.activeController = null;
        }

        if (
          acknowledged &&
          !this.disposed &&
          this.retryTimer === null &&
          this.pendingSequence !== null &&
          this.pendingSequence > this.acknowledgedSequence
        ) {
          this.schedule(0);
        }
      });
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      this.scheduler.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
