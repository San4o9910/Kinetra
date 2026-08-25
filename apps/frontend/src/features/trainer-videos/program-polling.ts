import type { TrainerVideoProgramResponse } from '@kinetra/shared';

export const TRAINER_VIDEO_PROGRAM_POLL_INTERVAL_MS = 2_000;
export const TRAINER_VIDEO_PROGRAM_POLL_MAX_DURATION_MS = 15 * 60 * 1_000;

const processingUploadStatuses = new Set(['completing', 'verification_pending', 'verifying']);

export interface TrainerVideoProgramPollingDependencies {
  readonly getProgram: (signal: AbortSignal) => Promise<TrainerVideoProgramResponse>;
  readonly getUpload: (uploadId: string, signal: AbortSignal) => Promise<unknown>;
  readonly isUploadActive: (videoId: string) => boolean;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delay: number) => number;
  readonly clearTimer: (timer: number) => void;
}

export interface TrainerVideoProgramPollingHandlers {
  readonly onProgram: (program: TrainerVideoProgramResponse) => void;
  readonly onError: (caught: unknown) => boolean;
  readonly onDeadline: () => void;
}

export interface TrainerVideoProgramPollingController {
  readonly start: () => void;
  readonly refresh: () => void;
  readonly setOnline: (online: boolean) => void;
  readonly dispose: () => void;
}

const backgroundProcessingUploadIds = (
  program: TrainerVideoProgramResponse,
  isUploadActive: (videoId: string) => boolean,
): readonly string[] => [
  ...new Set(
    program.weeks.flatMap((week) =>
      week.days.flatMap((slot) => {
        const upload = slot.live_upload;
        return upload !== null &&
          processingUploadStatuses.has(upload.status) &&
          !isUploadActive(slot.video_id)
          ? [upload.id]
          : [];
      }),
    ),
  ),
];

export const createTrainerVideoProgramPollingController = (
  dependencies: TrainerVideoProgramPollingDependencies,
  handlers: TrainerVideoProgramPollingHandlers,
  initiallyOnline: boolean,
): TrainerVideoProgramPollingController => {
  let disposed = false;
  let online = initiallyOnline;
  let generation = 0;
  let requestController: AbortController | null = null;
  let timer: number | null = null;
  let lastProgram: TrainerVideoProgramResponse | null = null;
  let pollingDeadline: number | null = null;
  let deadlineReported = false;

  const clearScheduledPoll = (): void => {
    if (timer === null) return;
    dependencies.clearTimer(timer);
    timer = null;
  };

  const beginRequest = (): {
    readonly controller: AbortController;
    readonly generation: number;
  } => {
    clearScheduledPoll();
    requestController?.abort();
    requestController = new AbortController();
    generation += 1;
    return { controller: requestController, generation };
  };

  const isCurrent = (candidateGeneration: number, controller: AbortController): boolean =>
    !disposed &&
    generation === candidateGeneration &&
    requestController === controller &&
    !controller.signal.aborted;

  const resetDeadline = (): void => {
    pollingDeadline = null;
    deadlineReported = false;
  };

  let refresh = (): void => undefined;

  const schedule = (program: TrainerVideoProgramResponse): void => {
    lastProgram = program;
    clearScheduledPoll();
    const uploadIds = backgroundProcessingUploadIds(program, dependencies.isUploadActive);
    if (!online || uploadIds.length === 0) {
      resetDeadline();
      return;
    }

    const now = dependencies.now();
    pollingDeadline ??= now + TRAINER_VIDEO_PROGRAM_POLL_MAX_DURATION_MS;
    if (now >= pollingDeadline) {
      if (!deadlineReported) {
        deadlineReported = true;
        handlers.onDeadline();
      }
      return;
    }

    timer = dependencies.setTimer(
      () => {
        timer = null;
        const request = beginRequest();
        void Promise.all(
          uploadIds.map((uploadId) => dependencies.getUpload(uploadId, request.controller.signal)),
        )
          .then(() => {
            if (isCurrent(request.generation, request.controller)) refresh();
          })
          .catch((caught: unknown) => {
            if (!isCurrent(request.generation, request.controller)) return;
            if (handlers.onError(caught) && lastProgram !== null) schedule(lastProgram);
          });
      },
      Math.min(TRAINER_VIDEO_PROGRAM_POLL_INTERVAL_MS, pollingDeadline - now),
    );
  };

  refresh = (): void => {
    if (disposed) return;
    const request = beginRequest();
    void dependencies
      .getProgram(request.controller.signal)
      .then((program) => {
        if (!isCurrent(request.generation, request.controller)) return;
        handlers.onProgram(program);
        schedule(program);
      })
      .catch((caught: unknown) => {
        if (!isCurrent(request.generation, request.controller)) return;
        if (handlers.onError(caught) && lastProgram !== null) schedule(lastProgram);
      });
  };

  return {
    start: refresh,
    refresh,
    setOnline: (nextOnline): void => {
      if (online === nextOnline || disposed) return;
      online = nextOnline;
      if (online) {
        refresh();
        return;
      }
      clearScheduledPoll();
      requestController?.abort();
      generation += 1;
      resetDeadline();
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      clearScheduledPoll();
      requestController?.abort();
      requestController = null;
      generation += 1;
      resetDeadline();
    },
  };
};
