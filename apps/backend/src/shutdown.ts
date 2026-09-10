export interface ShutdownOptions {
  readonly drainMs: number;
  readonly timeoutMs: number;
  markDraining(): void;
  closeRealtime(): Promise<void>;
  closeHttp(): Promise<void>;
  closeDatabase(): Promise<void>;
  reportFailure(stage: string): void;
  forceExit(): void;
}

export const createShutdownHandler = (options: ShutdownOptions): (() => Promise<void>) => {
  let pending: Promise<void> | null = null;
  return () => {
    if (pending !== null) return pending;
    options.markDraining();
    pending = (async () => {
      const deadline = setTimeout(() => {
        options.reportFailure('deadline');
        options.forceExit();
      }, options.timeoutMs);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, options.drainMs));
        for (const [stage, close] of [
          ['realtime', options.closeRealtime],
          ['http', options.closeHttp],
          ['database', options.closeDatabase],
        ] as const) {
          try {
            await close();
          } catch {
            options.reportFailure(stage);
          }
        }
      } finally {
        clearTimeout(deadline);
      }
    })();
    return pending;
  };
};
