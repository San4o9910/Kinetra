import type { TrainerVideoUploadDto } from '@kinetra/shared';

import {
  completeTrainerVideoUpload,
  createTrainerVideoUpload,
  getTrainerVideoUpload,
  getTrainerVideoUploadParts,
  signTrainerVideoParts,
} from '../../lib/api';

const MAX_CONCURRENCY = 3;
const wait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export const checksumVideoPart = async (blob: Blob): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

class PartUploadError extends Error {
  public constructor(public readonly status: number) {
    super(`Part upload failed with ${status}.`);
  }
}

export const putVideoPart = (
  url: string,
  blob: Blob,
  requiredHeaders: Readonly<Record<string, string>>,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = (): void => request.abort();
    request.open('PUT', url);
    request.withCredentials = false;
    Object.entries(requiredHeaders).forEach(([name, value]) =>
      request.setRequestHeader(name, value),
    );
    request.upload.addEventListener('progress', (event) =>
      onProgress(Math.min(blob.size, event.loaded)),
    );
    request.addEventListener('load', () => {
      signal.removeEventListener('abort', abort);
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new PartUploadError(request.status));
    });
    request.addEventListener('error', () => {
      signal.removeEventListener('abort', abort);
      reject(new PartUploadError(0));
    });
    request.addEventListener('abort', () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Aborted', 'AbortError'));
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener('abort', abort);
      request.abort();
      reject(new DOMException('Aborted', 'AbortError'));
    } else request.send(blob);
  });

export interface UploadWorkoutVideoOptions {
  readonly file: File;
  readonly weekNumber: number;
  readonly dayOfWeek: number;
  readonly existingUpload?: TrainerVideoUploadDto | null;
  readonly signal: AbortSignal;
  readonly onProgress: (bytes: number, total: number) => void;
  readonly onState: (upload: TrainerVideoUploadDto) => void;
  readonly dependencies?: Partial<UploadWorkoutVideoDependencies>;
}

export interface UploadWorkoutVideoDependencies {
  readonly createUpload: typeof createTrainerVideoUpload;
  readonly getUpload: typeof getTrainerVideoUpload;
  readonly getParts: typeof getTrainerVideoUploadParts;
  readonly signParts: typeof signTrainerVideoParts;
  readonly completeUpload: typeof completeTrainerVideoUpload;
  readonly putPart: typeof putVideoPart;
  readonly checksumPart: typeof checksumVideoPart;
  readonly delay: typeof wait;
  readonly now: () => number;
  readonly newIdempotencyKey: () => string;
}

const defaultDependencies: UploadWorkoutVideoDependencies = {
  createUpload: createTrainerVideoUpload,
  getUpload: getTrainerVideoUpload,
  getParts: getTrainerVideoUploadParts,
  signParts: signTrainerVideoParts,
  completeUpload: completeTrainerVideoUpload,
  putPart: putVideoPart,
  checksumPart: checksumVideoPart,
  delay: wait,
  now: Date.now,
  newIdempotencyKey: () => crypto.randomUUID(),
};

export const uploadWorkoutVideo = async (
  options: UploadWorkoutVideoOptions,
): Promise<TrainerVideoUploadDto> => {
  const { file } = options;
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', abortFromCaller, { once: true });
  if (options.signal.aborted) controller.abort(options.signal.reason);
  const signal = controller.signal;
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  if (
    !file.name.toLocaleLowerCase('en-US').endsWith('.mp4') ||
    (file.type !== '' && file.type !== 'video/mp4')
  )
    throw new Error('Выберите файл MP4.');
  let upload = options.existingUpload ?? null;
  if (upload === null) {
    upload = (
      await dependencies.createUpload(
        {
          week_number: options.weekNumber,
          day_of_week: options.dayOfWeek,
          mime_type: 'video/mp4',
          size_bytes: file.size,
        },
        dependencies.newIdempotencyKey(),
        signal,
      )
    ).upload;
  } else if (upload.expected_size_bytes !== file.size || upload.status !== 'uploading') {
    throw new Error('Повторно выберите тот же файл или отмените незавершённую загрузку.');
  }
  options.onState(upload);
  const sent = new Map<number, number>();
  const acceptedParts =
    upload.status === 'uploading' ? (await dependencies.getParts(upload.id, signal)).parts : [];
  for (const accepted of acceptedParts) {
    const expectedStart = (accepted.part_number - 1) * upload.part_size_bytes;
    const expectedSize = Math.min(upload.part_size_bytes, file.size - expectedStart);
    if (
      accepted.part_number >= 1 &&
      accepted.part_number <= upload.part_count &&
      accepted.size_bytes === expectedSize
    ) {
      const blob = file.slice(expectedStart, expectedStart + expectedSize);
      const checksum = await dependencies.checksumPart(blob);
      if (checksum !== accepted.checksum_sha256)
        throw new Error('Выбран другой файл. Отмените загрузку и начните заново.');
      sent.set(accepted.part_number, accepted.size_bytes);
    }
  }
  const report = (): void =>
    options.onProgress(
      [...sent.values()].reduce((sum, value) => sum + value, 0),
      file.size,
    );
  report();
  let nextPart = 1;
  let fatal: unknown;
  const worker = async (): Promise<void> => {
    while (!signal.aborted && fatal === undefined && nextPart <= upload!.part_count) {
      const partNumber = nextPart++;
      if (sent.has(partNumber)) continue;
      const start = (partNumber - 1) * upload!.part_size_bytes;
      const blob = file.slice(start, Math.min(file.size, start + upload!.part_size_bytes));
      const sha256 = await dependencies.checksumPart(blob);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (fatal !== undefined) throw fatal;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const signed = (
          await dependencies.signParts(
            upload!.id,
            [{ part_number: partNumber, checksum_sha256: sha256 }],
            signal,
          )
        ).parts[0]!;
        try {
          await dependencies.putPart(
            signed.upload_url,
            blob,
            signed.required_headers,
            signal,
            (bytes) => {
              sent.set(partNumber, Math.max(sent.get(partNumber) ?? 0, bytes));
              report();
            },
          );
          sent.set(partNumber, blob.size);
          report();
          break;
        } catch (caught) {
          if (attempt === 2 || caught instanceof DOMException) throw caught;
          await dependencies.delay(500 * 2 ** attempt, signal);
        }
      }
    }
  };
  const guardedWorker = async (): Promise<void> => {
    try {
      await worker();
    } catch (caught) {
      if (fatal === undefined) {
        fatal = caught;
        controller.abort(caught);
      }
      throw caught;
    }
  };
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENCY, upload.part_count) },
    guardedWorker,
  );
  await Promise.allSettled(workers);
  if (fatal !== undefined) throw fatal;
  upload = (await dependencies.completeUpload(upload.id, signal)).upload;
  options.onState(upload);
  const deadline = dependencies.now() + 15 * 60 * 1000;
  while (['verification_pending', 'verifying', 'completing'].includes(upload.status)) {
    if (dependencies.now() >= deadline)
      throw new Error('Проверка видео занимает больше времени. Статус сохранён на сервере.');
    await dependencies.delay(2_000, signal);
    upload =
      upload.status === 'completing'
        ? (await dependencies.completeUpload(upload.id, signal)).upload
        : (await dependencies.getUpload(upload.id, signal)).upload;
    options.onState(upload);
  }
  options.signal.removeEventListener('abort', abortFromCaller);
  return upload;
};
