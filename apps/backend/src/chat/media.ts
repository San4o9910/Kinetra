import type { Request } from 'express';
import { spawn } from 'node:child_process';

export const CHAT_PHOTO_INPUT_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_PHOTO_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
export const CHAT_PHOTO_MAX_PIXELS = 20_000_000;
export const CHAT_PHOTO_MAX_SIDE = 8192;
export const CHAT_PHOTO_NORMALIZED_MAX_SIDE = 2048;
export const CHAT_PHOTO_WEBP_QUALITY = 82;
export const CHAT_IMAGE_MAX_CONCURRENCY = 2;
export const CHAT_IMAGE_MAX_QUEUE_LENGTH = 8;
export const CHAT_IMAGE_COMMAND_TIMEOUT_MS = 15_000;
export const CHAT_IMAGE_STDERR_MAX_BYTES = 64 * 1024;
export const CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_MS = 15_000;
export const CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_MS = 120_000;

export class ChatMediaError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChatMediaError';
  }
}

export interface ParsedPhotoUpload {
  readonly bytes: Buffer;
  readonly declaredMimeType: string | null;
}

export interface ChatMultipartReadOptions {
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export class ChatMultipartAdmissionController {
  private active = 0;

  public constructor(private readonly maximumConcurrent: number) {
    if (!Number.isSafeInteger(maximumConcurrent) || maximumConcurrent < 1) {
      throw new Error('Multipart concurrency must be a positive safe integer.');
    }
  }

  public acquire(): () => void {
    if (this.active >= this.maximumConcurrent) {
      throw new ChatMediaError(
        429,
        'CHAT_RATE_LIMITED',
        'Photo upload capacity is busy. Try again later.',
      );
    }

    this.active += 1;
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.active -= 1;
    };
  }

  public get activeCount(): number {
    return this.active;
  }
}

const multipartAdmission = new ChatMultipartAdmissionController(10);

export const acquireChatMultipartSlot = (): (() => void) => multipartAdmission.acquire();

export interface NormalizedChatPhoto {
  readonly bytes: Buffer;
  readonly mimeType: 'image/webp';
  readonly width: number;
  readonly height: number;
}

export interface ChatImageProcessor {
  normalize(input: Buffer): Promise<NormalizedChatPhoto>;
}

export interface ChatMediaStore {
  readonly available: boolean;
  putObject(key: string, body: Buffer): Promise<void>;
  createSignedGet(key: string, expiresInSeconds: number): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export class UnavailableChatMediaStore implements ChatMediaStore {
  public readonly available = false;

  public async putObject(_key: string, _body: Buffer): Promise<void> {
    throw new Error('Chat media storage is unavailable.');
  }

  public async createSignedGet(_key: string, _expiresInSeconds: number): Promise<string> {
    throw new Error('Chat media storage is unavailable.');
  }

  public async deleteObject(_key: string): Promise<void> {
    throw new Error('Chat media storage is unavailable.');
  }
}

const multipartBoundaryFrom = (contentType: string | undefined): string => {
  if (contentType === undefined) {
    throw new ChatMediaError(400, 'CHAT_INVALID_REQUEST', 'A multipart photo upload is required.');
  }

  if (!/^multipart\/form-data(?:\s*;|$)/iu.test(contentType)) {
    throw new ChatMediaError(400, 'CHAT_INVALID_REQUEST', 'A multipart photo upload is required.');
  }

  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];

  if (boundary === undefined || boundary.length < 1 || boundary.length > 200) {
    throw new ChatMediaError(400, 'CHAT_INVALID_REQUEST', 'The multipart boundary is invalid.');
  }

  return boundary;
};

const parseHeaderLines = (rawHeaders: string): Map<string, string> => {
  const headers = new Map<string, string>();

  for (const line of rawHeaders.split('\r\n')) {
    const separator = line.indexOf(':');

    if (separator <= 0) {
      throw new ChatMediaError(400, 'CHAT_INVALID_REQUEST', 'Multipart headers are invalid.');
    }

    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (headers.has(name)) {
      throw new ChatMediaError(400, 'CHAT_INVALID_REQUEST', 'Duplicate multipart headers.');
    }

    headers.set(name, value);
  }

  return headers;
};

export const readSinglePhotoMultipart = async (
  request: Request,
  accountStreamedBytes: (bytes: number) => void = () => undefined,
  options: ChatMultipartReadOptions = {},
): Promise<ParsedPhotoUpload> => {
  const boundary = multipartBoundaryFrom(request.get('content-type'));
  const declaredLength = request.get('content-length');

  if (declaredLength !== undefined) {
    const length = Number(declaredLength);

    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ChatMediaError(400, 'CHAT_INVALID_REQUEST', 'Content-Length is invalid.');
    }

    if (length > CHAT_PHOTO_INPUT_MAX_BYTES + 64 * 1024) {
      throw new ChatMediaError(413, 'CHAT_PHOTO_TOO_LARGE', 'Photo input exceeds 10 MiB.');
    }
  }

  const idleTimeoutMs = options.idleTimeoutMs ?? CHAT_PHOTO_UPLOAD_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? CHAT_PHOTO_UPLOAD_TOTAL_TIMEOUT_MS;

  if (
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs < 1 ||
    !Number.isSafeInteger(totalTimeoutMs) ||
    totalTimeoutMs <= idleTimeoutMs
  ) {
    throw new Error('Multipart read deadlines are invalid.');
  }

  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let terminal = false;
    let idleTimer: NodeJS.Timeout | undefined;

    function cleanup(): void {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }

      clearTimeout(totalTimer);

      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
      request.removeListener('close', onClose);
    }

    function finish(error?: unknown): void {
      if (terminal) {
        return;
      }

      terminal = true;
      cleanup();

      if (error === undefined) {
        resolve(Buffer.concat(chunks, totalBytes));
      } else {
        request.pause();
        const ignoreLateStreamError = (): void => undefined;
        const removeLateStreamGuard = (): void => {
          request.removeListener('error', ignoreLateStreamError);
        };
        request.on('error', ignoreLateStreamError);
        request.once('close', removeLateStreamGuard);
        reject(error);
      }
    }

    function timeout(): void {
      finish(
        new ChatMediaError(
          408,
          'CHAT_PHOTO_UPLOAD_TIMEOUT',
          'Photo upload body was not received within the allowed time.',
        ),
      );
    }

    function armIdleTimer(): void {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }

      idleTimer = setTimeout(timeout, idleTimeoutMs);
      idleTimer.unref();
    }

    function onData(rawChunk: Buffer | Uint8Array | string): void {
      if (terminal) {
        return;
      }

      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);

      try {
        totalBytes += chunk.length;
        accountStreamedBytes(chunk.length);

        if (totalBytes > CHAT_PHOTO_INPUT_MAX_BYTES + 64 * 1024) {
          finish(new ChatMediaError(413, 'CHAT_PHOTO_TOO_LARGE', 'Photo input exceeds 10 MiB.'));
          return;
        }

        chunks.push(chunk);
        armIdleTimer();
      } catch (error) {
        finish(error);
      }
    }

    function onEnd(): void {
      finish();
    }

    function onError(error: Error): void {
      finish(error);
    }

    function onAborted(): void {
      finish(new ChatMediaError(400, 'CHAT_INVALID_REQUEST', 'Photo upload was aborted.'));
    }

    function onClose(): void {
      if (!request.complete) {
        onAborted();
      }
    }

    armIdleTimer();
    const totalTimer = setTimeout(timeout, totalTimeoutMs);
    totalTimer.unref();
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
    request.once('close', onClose);

    if (request.aborted) {
      onAborted();
    }
  });
  const opening = Buffer.from(`--${boundary}\r\n`, 'utf8');

  if (!body.subarray(0, opening.length).equals(opening)) {
    throw new ChatMediaError(400, 'CHAT_INVALID_REQUEST', 'Multipart body is invalid.');
  }

  const headerEnd = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), opening.length);

  if (headerEnd < 0 || headerEnd - opening.length > 16 * 1024) {
    throw new ChatMediaError(400, 'CHAT_INVALID_REQUEST', 'Multipart headers are invalid.');
  }

  const headers = parseHeaderLines(body.toString('utf8', opening.length, headerEnd));
  const disposition = headers.get('content-disposition');

  if (
    disposition === undefined ||
    !/^form-data(?:;|$)/iu.test(disposition) ||
    !/(?:^|;)\s*name="photo"(?:;|$)/u.test(disposition) ||
    !/(?:^|;)\s*filename="[^"]*"(?:;|$)/u.test(disposition)
  ) {
    throw new ChatMediaError(
      400,
      'CHAT_INVALID_REQUEST',
      'Upload exactly one file in the photo field.',
    );
  }

  const fileStart = headerEnd + 4;
  const closingMarker = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const fileEnd = body.indexOf(closingMarker, fileStart);

  if (fileEnd < 0) {
    throw new ChatMediaError(400, 'CHAT_INVALID_REQUEST', 'Multipart body is incomplete.');
  }

  const closingEnd = fileEnd + closingMarker.length;
  const trailing = body.subarray(closingEnd);

  if (!(trailing.length === 0 || trailing.equals(Buffer.from('\r\n', 'utf8')))) {
    throw new ChatMediaError(
      400,
      'CHAT_INVALID_REQUEST',
      'Upload exactly one file in the photo field.',
    );
  }

  const bytes = body.subarray(fileStart, fileEnd);

  if (bytes.length === 0) {
    throw new ChatMediaError(422, 'CHAT_PHOTO_INVALID', 'Photo input is empty.');
  }

  if (bytes.length > CHAT_PHOTO_INPUT_MAX_BYTES) {
    throw new ChatMediaError(413, 'CHAT_PHOTO_TOO_LARGE', 'Photo input exceeds 10 MiB.');
  }

  return {
    bytes: Buffer.from(bytes),
    declaredMimeType: headers.get('content-type')?.toLowerCase() ?? null,
  };
};

type SupportedInputFormat = 'JPEG' | 'PNG' | 'WEBP';

const detectInputFormat = (input: Buffer): SupportedInputFormat | null => {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) {
    return 'JPEG';
  }

  if (input.length >= 8 && input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'PNG';
  }

  if (
    input.length >= 12 &&
    input.toString('ascii', 0, 4) === 'RIFF' &&
    input.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'WEBP';
  }

  return null;
};

const containsBytes = (input: Buffer, value: string): boolean =>
  input.indexOf(Buffer.from(value, 'ascii')) >= 0;

const invalidContainer = (): ChatMediaError =>
  new ChatMediaError(422, 'CHAT_PHOTO_INVALID', 'Photo image container is invalid.');

const assertJpegContainer = (input: Buffer): void => {
  let offset = 2;
  let entropyCoded = false;

  while (offset < input.length) {
    if (input[offset] !== 0xff) {
      if (!entropyCoded) {
        throw invalidContainer();
      }

      offset += 1;
      continue;
    }

    while (input[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= input.length) {
      throw invalidContainer();
    }

    const marker = input[offset]!;
    offset += 1;

    if (entropyCoded && marker === 0x00) {
      continue;
    }

    if (marker === 0xd9) {
      if (offset !== input.length) {
        throw invalidContainer();
      }

      return;
    }

    if (marker === 0xd8 || marker === 0x00) {
      throw invalidContainer();
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (marker >= 0xd0 && marker <= 0xd7 && !entropyCoded) {
        throw invalidContainer();
      }

      continue;
    }

    if (offset + 2 > input.length) {
      throw invalidContainer();
    }

    const segmentLength = input.readUInt16BE(offset);

    if (segmentLength < 2 || offset + segmentLength > input.length) {
      throw invalidContainer();
    }

    offset += segmentLength;
    entropyCoded = marker === 0xda;
  }

  throw invalidContainer();
};

const assertPngContainer = (input: Buffer): void => {
  let offset = 8;
  let firstChunk = true;

  while (offset < input.length) {
    if (offset + 12 > input.length) {
      throw invalidContainer();
    }

    const dataLength = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + dataLength;

    if (chunkEnd > input.length || (firstChunk && (type !== 'IHDR' || dataLength !== 13))) {
      throw invalidContainer();
    }

    if (type === 'IEND') {
      if (dataLength !== 0 || chunkEnd !== input.length) {
        throw invalidContainer();
      }

      return;
    }

    firstChunk = false;
    offset = chunkEnd;
  }

  throw invalidContainer();
};

const assertContainerHasNoTrailingPayload = (input: Buffer, format: SupportedInputFormat): void => {
  if (format === 'JPEG') {
    assertJpegContainer(input);
    return;
  }

  if (format === 'PNG') {
    assertPngContainer(input);
    return;
  }

  if (input.length < 12 || input.readUInt32LE(4) + 8 !== input.length) {
    throw invalidContainer();
  }
};

const assertInputEnvelope = (input: Buffer): SupportedInputFormat => {
  if (input.length > CHAT_PHOTO_INPUT_MAX_BYTES) {
    throw new ChatMediaError(413, 'CHAT_PHOTO_TOO_LARGE', 'Photo input exceeds 10 MiB.');
  }

  const format = detectInputFormat(input);

  if (format === null) {
    throw new ChatMediaError(
      415,
      'CHAT_PHOTO_UNSUPPORTED',
      'Only static JPEG, PNG, and WebP photos are supported. HEIC is not supported.',
    );
  }

  if (
    containsBytes(input, '%PDF-') ||
    containsBytes(input, '<svg') ||
    containsBytes(input, '<SVG') ||
    containsBytes(input, 'ftypheic') ||
    containsBytes(input, 'ftypheif') ||
    containsBytes(input, 'ftypavif') ||
    (format === 'PNG' && containsBytes(input, 'acTL')) ||
    (format === 'WEBP' && (containsBytes(input, 'ANIM') || containsBytes(input, 'ANMF')))
  ) {
    throw new ChatMediaError(
      415,
      'CHAT_PHOTO_UNSUPPORTED',
      'Animated or unsupported photo content is not allowed.',
    );
  }

  assertContainerHasNoTrailingPayload(input, format);

  return format;
};

interface CommandResult {
  readonly stdout: Buffer;
}

const runImageCommand = async (
  command: string,
  arguments_: readonly string[],
  input: Buffer,
  maximumOutputBytes: number,
): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, arguments_, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    let stderrBytes = 0;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, CHAT_IMAGE_COMMAND_TIMEOUT_MS);

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    child.on('error', () =>
      fail(
        new ChatMediaError(
          503,
          'CHAT_PHOTO_STORAGE_UNAVAILABLE',
          'Photo processing is temporarily unavailable.',
        ),
      ),
    );
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;

      if (stdoutBytes > maximumOutputBytes) {
        child.kill('SIGKILL');
        fail(new ChatMediaError(422, 'CHAT_PHOTO_INVALID', 'Normalized photo is too large.'));
        return;
      }

      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;

      if (stderrBytes > CHAT_IMAGE_STDERR_MAX_BYTES) {
        child.kill('SIGKILL');
      }
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new ChatMediaError(422, 'CHAT_PHOTO_INVALID', 'Photo decoding failed.'));
        return;
      }

      resolve({ stdout: Buffer.concat(stdout, stdoutBytes) });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

interface IdentifiedImage {
  readonly format: SupportedInputFormat;
  readonly width: number;
  readonly height: number;
}

const identifyImage = async (input: Buffer): Promise<IdentifiedImage> => {
  const result = await runImageCommand(
    'identify',
    [
      '-regard-warnings',
      '-limit',
      'memory',
      '128MiB',
      '-limit',
      'map',
      '256MiB',
      '-limit',
      'disk',
      '0',
      '-limit',
      'thread',
      '1',
      '-ping',
      '-format',
      '%m|%w|%h\\n',
      '-',
    ],
    input,
    16 * 1024,
  );
  const records = result.stdout.toString('utf8').trim().split('\n').filter(Boolean);

  if (records.length !== 1) {
    throw new ChatMediaError(415, 'CHAT_PHOTO_UNSUPPORTED', 'Animated photos are not supported.');
  }

  const [rawFormat, rawWidth, rawHeight] = records[0]?.split('|') ?? [];
  const width = Number(rawWidth);
  const height = Number(rawHeight);

  if (
    !['JPEG', 'PNG', 'WEBP'].includes(rawFormat ?? '') ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new ChatMediaError(422, 'CHAT_PHOTO_INVALID', 'Photo metadata is invalid.');
  }

  if (width > CHAT_PHOTO_MAX_SIDE || height > CHAT_PHOTO_MAX_SIDE) {
    throw new ChatMediaError(422, 'CHAT_PHOTO_INVALID', 'Photo dimensions are too large.');
  }

  if (width * height > CHAT_PHOTO_MAX_PIXELS) {
    throw new ChatMediaError(422, 'CHAT_PHOTO_INVALID', 'Photo pixel count is too large.');
  }

  return { format: rawFormat as SupportedInputFormat, width, height };
};

interface PendingJob {
  readonly input: Buffer;
  readonly resolve: (result: NormalizedChatPhoto) => void;
  readonly reject: (error: unknown) => void;
}

export class ImageMagickChatImageProcessor implements ChatImageProcessor {
  private activeJobs = 0;
  private readonly pending: PendingJob[] = [];

  public constructor(
    private readonly maximumConcurrency = CHAT_IMAGE_MAX_CONCURRENCY,
    private readonly maximumQueueLength = CHAT_IMAGE_MAX_QUEUE_LENGTH,
  ) {}

  public async normalize(input: Buffer): Promise<NormalizedChatPhoto> {
    if (this.activeJobs < this.maximumConcurrency) {
      return this.run(input);
    }

    if (this.pending.length >= this.maximumQueueLength) {
      throw new ChatMediaError(
        429,
        'CHAT_RATE_LIMITED',
        'Photo processing is busy. Try again later.',
      );
    }

    return new Promise<NormalizedChatPhoto>((resolve, reject) => {
      this.pending.push({ input: Buffer.from(input), resolve, reject });
    });
  }

  private async run(input: Buffer): Promise<NormalizedChatPhoto> {
    this.activeJobs += 1;

    try {
      const envelopeFormat = assertInputEnvelope(input);
      const identified = await identifyImage(input);

      if (identified.format !== envelopeFormat) {
        throw new ChatMediaError(415, 'CHAT_PHOTO_UNSUPPORTED', 'Photo content is ambiguous.');
      }

      const converted = await runImageCommand(
        'convert',
        [
          '-regard-warnings',
          '-limit',
          'memory',
          '128MiB',
          '-limit',
          'map',
          '256MiB',
          '-limit',
          'disk',
          '0',
          '-limit',
          'thread',
          '1',
          '-',
          '-auto-orient',
          '-resize',
          `${CHAT_PHOTO_NORMALIZED_MAX_SIDE}x${CHAT_PHOTO_NORMALIZED_MAX_SIDE}>`,
          '-strip',
          '-define',
          'webp:lossless=false',
          '-quality',
          String(CHAT_PHOTO_WEBP_QUALITY),
          'webp:-',
        ],
        input,
        CHAT_PHOTO_OUTPUT_MAX_BYTES,
      );
      const output = converted.stdout;

      if (output.length < 1 || output.length > CHAT_PHOTO_OUTPUT_MAX_BYTES) {
        throw new ChatMediaError(422, 'CHAT_PHOTO_INVALID', 'Normalized photo is too large.');
      }

      const normalized = await identifyImage(output);

      if (
        normalized.format !== 'WEBP' ||
        normalized.width > CHAT_PHOTO_NORMALIZED_MAX_SIDE ||
        normalized.height > CHAT_PHOTO_NORMALIZED_MAX_SIDE
      ) {
        throw new ChatMediaError(422, 'CHAT_PHOTO_INVALID', 'Photo normalization failed.');
      }

      return {
        bytes: output,
        mimeType: 'image/webp',
        width: normalized.width,
        height: normalized.height,
      };
    } finally {
      this.activeJobs -= 1;
      this.startNext();
    }
  }

  private startNext(): void {
    const next = this.pending.shift();

    if (next === undefined) {
      return;
    }

    void this.run(next.input).then(next.resolve, next.reject);
  }
}
