export interface AccountDeletionLifecycle {
  readonly prepareAccountDeletion: (confirmation: string) => () => Promise<void>;
  readonly captureBrowserSubscription: () => Promise<PushSubscription | null>;
  readonly unsubscribeBrowserSubscription: (subscription: PushSubscription | null) => Promise<void>;
  readonly onChatSessionSuspend?: () => void;
  readonly onChatSessionRestart?: () => void;
  readonly onChatSessionEnd?: () => void;
  readonly onSignedOut: () => void;
}

export interface BestEffortOperationControl {
  readonly signal: AbortSignal;
  readonly beginSideEffects: () => boolean;
}

export const settleBestEffortWithin = async (
  operation: (control: BestEffortOperationControl) => Promise<unknown>,
  timeoutMs: number,
): Promise<void> => {
  const controller = new AbortController();
  let sideEffectsStarted = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const beginSideEffects = (): boolean => {
    if (controller.signal.aborted) {
      return false;
    }

    sideEffectsStarted = true;
    return true;
  };
  const pendingOperation = Promise.resolve()
    .then(() => operation({ signal: controller.signal, beginSideEffects }))
    .catch(() => undefined);
  const timeout = new Promise<void>((resolve) => {
    timer = globalThis.setTimeout(() => {
      controller.abort();

      if (!sideEffectsStarted) {
        resolve();
      }
    }, timeoutMs);
  });

  try {
    await Promise.race([pendingOperation, timeout]);
  } finally {
    controller.abort();

    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  }
};

export const runAccountDeletionLifecycle = async (
  confirmation: string,
  lifecycle: AccountDeletionLifecycle,
): Promise<void> => {
  const deleteAccount = lifecycle.prepareAccountDeletion(confirmation);
  lifecycle.onChatSessionSuspend?.();

  try {
    const subscription = await lifecycle.captureBrowserSubscription();

    await lifecycle.unsubscribeBrowserSubscription(subscription);
    await deleteAccount();
  } catch (error) {
    lifecycle.onChatSessionRestart?.();
    throw error;
  }

  lifecycle.onChatSessionEnd?.();
  lifecycle.onSignedOut();
};
