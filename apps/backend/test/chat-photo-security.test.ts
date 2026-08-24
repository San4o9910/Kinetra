import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

import type { Request } from 'express';

import { HttpError } from '../src/auth/errors.js';
import { ChatMediaCleanupService } from '../src/chat/cleanup-service.js';
import {
  CHAT_IMAGE_COMMAND_TIMEOUT_MS,
  CHAT_IMAGE_MAX_CONCURRENCY,
  CHAT_IMAGE_MAX_QUEUE_LENGTH,
  CHAT_IMAGE_STDERR_MAX_BYTES,
  CHAT_PHOTO_INPUT_MAX_BYTES,
  CHAT_PHOTO_OUTPUT_MAX_BYTES,
  CHAT_PHOTO_WEBP_QUALITY,
  ChatMultipartAdmissionController,
  ChatMediaError,
  ImageMagickChatImageProcessor,
  UnavailableChatMediaStore,
  readSinglePhotoMultipart,
} from '../src/chat/media.js';
import {
  InMemoryChatRateLimiter,
  NoopChatRateLimiter,
  type ChatRateLimiter,
} from '../src/chat/rate-limit.js';
import { ChatService } from '../src/chat/service.js';
import {
  FakeChatImageProcessor,
  FakeChatMediaStore,
  FixedChatClock,
} from './support/fake-chat-media.js';
import { InMemoryChatRepository } from './support/in-memory-chat.repository.js';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const VALID_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);
const ORIENTED_EXIF_JPEG = Buffer.from(
  '/9j/4QAiRXhpZgAASUkqAAgAAAABABIBAwABAAAABgAAAAAAAAD/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAADAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABoQAAAHAAAAAAAAAAAAAAAAAAABBAYWVZH/xAAVAQEBAAAAAAAAAAAAAAAAAAAFCP/EABwRAAAHAQEAAAAAAAAAAAAAAAABAxdVkdEGB//aAAwDAQACEQMRAD8AB8vctwo0hfzH+eRKVHoSeLu5NWywf//Z',
  'base64',
);
const METADATA_RICH_JPEG = Buffer.from(
  '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',
  'base64',
);
const ANIMATED_WEBP = Buffer.from(
  'UklGRsAAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAD/////AABBTk1GSAAAAAAAAAAAAAAAAAAAAGQAAAJWUDggMAAAANABAJ0BKgEAAQACADQloAJ0ugH4AAOwAP7wxAv/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAAAAAAAAAAZAAAAFZQOCAsAAAAlAEAnQEqAQABAAAANCWgAnS6AAOYAP75k2//kB//kB//kB//ID/iF3sgMAA=',
  'base64',
);
const ANIMATED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAACGFjVEwAAAAGAAAAAAYNNbAAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEAGQAARB8t+QAAAAxJREFUeJxj+M/ABAADAwECv+VluwAAABpmY1RMAAAAAQAAAAEAAAABAAAAAAAAAAAAAQAZAADfbMctAAAAEGZkQVQAAAACeJxj+M/ABAADAwEC39NKowAAABpmY1RMAAAAAwAAAAEAAAABAAAAAAAAAAAAAQAZAAAy+hTEAAAAEGZkQVQAAAAEeJxj+M/ABAADAwECfzaVfgAAABpmY1RMAAAABQAAAAEAAAABAAAAAAAAAAAAAQAZAADfMGa+AAAAEGZkQVQAAAAGeJxjYGL4DwABCQECCbpk5QAAABpmY1RMAAAABwAAAAEAAAABAAAAAAAAAAAAAQAZAAAyprVXAAAAEGZkQVQAAAAIeJxjYGL4DwABCQEC81xoVQAAABpmY1RMAAAACQAAAAEAAAABAAAAAAAAAAAAAQAZAADf1YQLAAAAEGZkQVQAAAAKeJxjYGL4DwABCQECkwDdHgAAAABJRU5ErkJggg==',
  'base64',
);

const mediaError =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof ChatMediaError && error.code === code;

const crc32 = (input: Buffer): number => {
  let value = 0xffffffff;

  for (const byte of input) {
    value ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }

  return (value ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Buffer): Buffer => {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
};

const grayscalePng = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const scanlines = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const multipartRequest = (
  boundary: string,
  bytes: Buffer,
  declaredMimeType: string,
  includeContentLength = true,
): Request => {
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="unsafe.heic"\r\nContent-Type: ${declaredMimeType}\r\n\r\n`,
    'utf8',
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([prefix, bytes, suffix]);
  const request = Readable.from([
    body.subarray(0, Math.floor(body.length / 2)),
    body.subarray(Math.floor(body.length / 2)),
  ]) as Readable & { get(name: string): string | undefined };
  request.get = (name: string): string | undefined => {
    if (name.toLowerCase() === 'content-type') {
      return `multipart/form-data; boundary=${boundary}`;
    }

    if (name.toLowerCase() === 'content-length') {
      return includeContentLength ? String(body.length) : undefined;
    }

    return undefined;
  };
  return request as unknown as Request;
};

const createPhotoService = (
  repository: InMemoryChatRepository,
  mediaStore: FakeChatMediaStore | UnavailableChatMediaStore,
  imageProcessor: FakeChatImageProcessor,
  clock: FixedChatClock,
  rateLimiter: ChatRateLimiter = new NoopChatRateLimiter(),
): ChatService =>
  new ChatService({
    repository,
    eventPublisher: { publish: async () => undefined },
    rateLimiter,
    imageProcessor,
    mediaStore,
    clock,
    enabled: true,
    photoUploadsEnabled: true,
    mediaUrlTtlSeconds: 300,
    cursorSecret: 'test-only-photo-security-cursor-secret-32-bytes',
  });

test('real decoder and upload state machine enforce the complete photo security boundary', async () => {
  {
    const processor = new ImageMagickChatImageProcessor();
    const normalizedPng = await processor.normalize(VALID_PNG);
    assert.equal(normalizedPng.mimeType, 'image/webp');
    assert.equal(normalizedPng.width, 1);
    assert.equal(normalizedPng.height, 1);
    assert.equal(normalizedPng.bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(normalizedPng.bytes.toString('ascii', 8, 12), 'WEBP');
    assert.notEqual(normalizedPng.bytes.indexOf(Buffer.from('VP8 ', 'ascii')), -1);
    assert.equal(normalizedPng.bytes.length <= CHAT_PHOTO_OUTPUT_MAX_BYTES, true);

    const normalizedJpeg = await processor.normalize(VALID_JPEG);
    assert.equal(normalizedJpeg.mimeType, 'image/webp');
    assert.deepEqual([normalizedJpeg.width, normalizedJpeg.height], [2, 2]);

    const normalizedWebp = await processor.normalize(normalizedPng.bytes);
    assert.equal(normalizedWebp.mimeType, 'image/webp');
    assert.deepEqual([normalizedWebp.width, normalizedWebp.height], [1, 1]);

    const oriented = await processor.normalize(ORIENTED_EXIF_JPEG);
    assert.deepEqual([oriented.width, oriented.height], [3, 2]);

    const metadataMarkers = [
      'Exif',
      'GPSLatitude',
      'x:xmpmeta',
      'ICC_PROFILE',
      'Kinetra metadata stripping fixture',
    ] as const;
    for (const metadataMarker of metadataMarkers) {
      assert.equal(
        METADATA_RICH_JPEG.includes(Buffer.from(metadataMarker, 'ascii')),
        true,
        `metadata fixture must contain ${metadataMarker}`,
      );
    }
    const strippedMetadata = await processor.normalize(METADATA_RICH_JPEG);
    assert.deepEqual([strippedMetadata.width, strippedMetadata.height], [3, 2]);
    for (const metadataMarker of metadataMarkers) {
      assert.equal(
        strippedMetadata.bytes.includes(Buffer.from(metadataMarker, 'ascii')),
        false,
        `normalized WebP must strip ${metadataMarker}`,
      );
    }

    const resized = await processor.normalize(grayscalePng(4096, 2));
    assert.deepEqual([resized.width, resized.height], [2048, 1]);
    assert.equal(resized.bytes.length <= CHAT_PHOTO_OUTPUT_MAX_BYTES, true);
    assert.equal(CHAT_PHOTO_WEBP_QUALITY, 82);
  }

  {
    const processor = new ImageMagickChatImageProcessor();
    const unsupported: readonly [string, Buffer][] = [
      ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
      ['GIF', Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')],
      ['animated WebP', ANIMATED_WEBP],
      ['animated PNG', ANIMATED_PNG],
      ['PDF', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj')],
      ['HEIC', Buffer.from('0000001866747970686569630000000068656963', 'hex')],
      ['HEIF', Buffer.from('0000001866747970686569660000000068656966', 'hex')],
      ['AVIF', Buffer.from('0000001866747970617669660000000061766966', 'hex')],
      ['TIFF', Buffer.from('49492a0008000000', 'hex')],
    ];

    for (const [name, input] of unsupported) {
      await assert.rejects(
        processor.normalize(input),
        mediaError('CHAT_PHOTO_UNSUPPORTED'),
        `${name} must be rejected`,
      );
    }

    const invalid = [
      Buffer.concat([VALID_PNG.subarray(0, 12), Buffer.from('corrupt')]),
      Buffer.concat([VALID_JPEG, Buffer.from('<script>alert(1)</script>')]),
      Buffer.concat([VALID_PNG, Buffer.from('PK\u0003\u0004polyglot')]),
      Buffer.concat([VALID_JPEG, VALID_JPEG]),
      Buffer.concat([VALID_PNG, VALID_PNG]),
      Buffer.concat([VALID_JPEG.subarray(0, -2), Buffer.alloc(32, 0x00), VALID_JPEG.subarray(-2)]),
    ];

    for (const input of invalid) {
      await assert.rejects(processor.normalize(input), mediaError('CHAT_PHOTO_INVALID'));
    }

    await assert.rejects(
      processor.normalize(Buffer.alloc(CHAT_PHOTO_INPUT_MAX_BYTES + 1, 0xff)),
      mediaError('CHAT_PHOTO_TOO_LARGE'),
    );
    await assert.rejects(
      processor.normalize(grayscalePng(4473, 4473)),
      mediaError('CHAT_PHOTO_INVALID'),
      'valid input above 20 MP must be rejected before full conversion',
    );
    await assert.rejects(
      processor.normalize(grayscalePng(8193, 1)),
      mediaError('CHAT_PHOTO_INVALID'),
      'valid input with an extreme side must be rejected',
    );
  }

  {
    const parsed = await readSinglePhotoMultipart(
      multipartRequest('kinetra-test-boundary', VALID_PNG, 'image/heic'),
    );
    assert.equal(parsed.declaredMimeType, 'image/heic');
    assert.deepEqual(parsed.bytes, VALID_PNG);
    assert.equal(Object.hasOwn(parsed, 'filename'), false, 'original filename is discarded');
    assert.equal(
      (await new ImageMagickChatImageProcessor().normalize(parsed.bytes)).mimeType,
      'image/webp',
    );

    let oversizedStreamedBytes = 0;
    await assert.rejects(
      readSinglePhotoMultipart(
        multipartRequest(
          'kinetra-oversized-stream-boundary',
          Buffer.alloc(CHAT_PHOTO_INPUT_MAX_BYTES + 64 * 1024, 0xff),
          'image/png',
          false,
        ),
        (bytes) => {
          oversizedStreamedBytes += bytes;
        },
      ),
      mediaError('CHAT_PHOTO_TOO_LARGE'),
    );
    assert.equal(
      oversizedStreamedBytes > CHAT_PHOTO_INPUT_MAX_BYTES + 64 * 1024,
      true,
      'the chunk crossing the streamed size limit must be charged before the 413 response',
    );

    const admission = new ChatMultipartAdmissionController(1);
    const release = admission.acquire();
    assert.throws(() => admission.acquire(), mediaError('CHAT_RATE_LIMITED'));
    release();
    release();
    const releaseNext = admission.acquire();
    releaseNext();

    const boundedProcessor = new ImageMagickChatImageProcessor(2, 1);
    const first = boundedProcessor.normalize(VALID_PNG);
    const second = boundedProcessor.normalize(VALID_JPEG);
    const queued = boundedProcessor.normalize(VALID_PNG);
    await assert.rejects(boundedProcessor.normalize(VALID_JPEG), mediaError('CHAT_RATE_LIMITED'));
    await Promise.all([first, second, queued]);
    assert.equal(CHAT_IMAGE_MAX_CONCURRENCY, 2);
    assert.equal(CHAT_IMAGE_MAX_QUEUE_LENGTH, 8);
    assert.equal(CHAT_IMAGE_COMMAND_TIMEOUT_MS, 15_000);
    assert.equal(CHAT_IMAGE_STDERR_MAX_BYTES, 64 * 1024);
  }

  {
    const repository = new InMemoryChatRepository();
    const clock = new FixedChatClock(new Date('2026-08-23T10:00:00.000Z'));
    const mediaStore = new FakeChatMediaStore();
    const baseProcessor = new FakeChatImageProcessor();
    const blockingProcessor = new FakeChatImageProcessor();
    let signalNormalize!: () => void;
    let releaseNormalize!: () => void;
    const normalizeStarted = new Promise<void>((resolve) => {
      signalNormalize = resolve;
    });
    const holdNormalize = new Promise<void>((resolve) => {
      releaseNormalize = resolve;
    });
    blockingProcessor.normalize = async (input) => {
      signalNormalize();
      await holdNormalize;
      return baseProcessor.normalize(input);
    };
    const service = createPhotoService(repository, mediaStore, blockingProcessor, clock);
    const sessionId = randomUUID();
    repository.addSession(repository.clientId, sessionId);
    const conversation = await repository.createOrGetConversation(repository.clientId, clock.now());
    assert.notEqual(conversation, null);
    const context = { userId: repository.clientId, sessionId, ip: '127.0.0.1' };
    const uploadId = randomUUID();
    const bytes = Buffer.from('decoded-photo-fixture');
    await service.preflightPhotoUpload(context);
    const firstUpload = service.uploadPhotoAfterPreflight(
      context,
      conversation!.conversation.id,
      uploadId,
      bytes,
    );
    await normalizeStarted;

    await service.preflightPhotoUpload(context);
    const processingReplay = await service.uploadPhotoAfterPreflight(
      context,
      conversation!.conversation.id,
      uploadId,
      bytes,
    );
    assert.equal(processingReplay.statusCode, 202);
    assert.equal(processingReplay.photo.status, 'processing');

    await service.preflightPhotoUpload(context);
    await assert.rejects(
      service.uploadPhotoAfterPreflight(
        context,
        conversation!.conversation.id,
        uploadId,
        Buffer.from('different-photo-fixture'),
      ),
      (error: unknown) =>
        error instanceof HttpError && error.code === 'CHAT_UPLOAD_IDEMPOTENCY_CONFLICT',
    );
    releaseNormalize();
    const ready = await firstUpload;
    assert.equal(ready.statusCode, 201);
    assert.equal(ready.photo.status, 'ready');
    const stored = repository.peekPhoto();
    assert.notEqual(stored, null);
    assert.match(stored!.objectKey, /^chat\/[0-9a-f]{2}\/[0-9a-f-]{36}\.webp$/u);
    assert.equal(stored!.objectKey.includes('unsafe.heic'), false);
    assert.equal(mediaStore.objects.has(stored!.objectKey), true);
    assert.equal((await service.getPhotoStatus(context, stored!.id)).status, 'ready');

    const unavailable = createPhotoService(
      repository,
      new UnavailableChatMediaStore(),
      new FakeChatImageProcessor(),
      clock,
    );
    await assert.rejects(
      unavailable.preflightPhotoUpload(context),
      (error: unknown) =>
        error instanceof HttpError && error.code === 'CHAT_PHOTO_STORAGE_UNAVAILABLE',
    );
  }

  {
    const repository = new InMemoryChatRepository();
    const start = new Date('2026-08-23T10:00:00.000Z');
    const clock = new FixedChatClock(start);
    const mediaStore = new FakeChatMediaStore();
    const service = createPhotoService(repository, mediaStore, new FakeChatImageProcessor(), clock);
    const sessionId = randomUUID();
    repository.addSession(repository.clientId, sessionId);
    const conversation = await repository.createOrGetConversation(repository.clientId, clock.now());
    assert.notEqual(conversation, null);
    const context = { userId: repository.clientId, sessionId, ip: '127.0.0.1' };
    repository.markPhotoReady = async () => null;
    await service.preflightPhotoUpload(context);
    await assert.rejects(
      service.uploadPhotoAfterPreflight(
        context,
        conversation!.conversation.id,
        randomUUID(),
        Buffer.from('valid-photo'),
      ),
      (error: unknown) =>
        error instanceof HttpError && error.code === 'CHAT_PHOTO_STORAGE_UNAVAILABLE',
    );
    const stranded = repository.peekPhoto();
    assert.equal(stranded?.status, 'processing');
    assert.equal(mediaStore.objects.has(stranded!.objectKey), true);
    clock.set(new Date(start.getTime() + 6 * 60 * 1000));
    const cleanup = await new ChatMediaCleanupService(repository, mediaStore, clock).runOnce();
    assert.equal(cleanup.stalePhotosRemoved, 1);
    assert.equal(cleanup.deletionsCompleted, 1);
    assert.equal(mediaStore.objects.has(stranded!.objectKey), false);

    const retryRepository = new InMemoryChatRepository();
    const retryClock = new FixedChatClock(start);
    const failingProcessor = new FakeChatImageProcessor();
    failingProcessor.failure = new ChatMediaError(422, 'CHAT_PHOTO_INVALID', 'invalid fixture');
    const retryService = createPhotoService(
      retryRepository,
      new FakeChatMediaStore(),
      failingProcessor,
      retryClock,
    );
    const retrySessionId = randomUUID();
    retryRepository.addSession(retryRepository.clientId, retrySessionId);
    const retryConversation = await retryRepository.createOrGetConversation(
      retryRepository.clientId,
      retryClock.now(),
    );
    assert.notEqual(retryConversation, null);
    const retryContext = {
      userId: retryRepository.clientId,
      sessionId: retrySessionId,
      ip: '127.0.0.2',
    };
    const retryUploadId = randomUUID();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await retryService.preflightPhotoUpload(retryContext);
      await assert.rejects(
        retryService.uploadPhotoAfterPreflight(
          retryContext,
          retryConversation!.conversation.id,
          retryUploadId,
          Buffer.from('same-invalid-photo'),
        ),
        mediaError('CHAT_PHOTO_INVALID'),
      );
      assert.equal(retryRepository.peekPhoto()?.attemptCount, attempt);
    }

    const exhaustedPhoto = retryRepository.peekPhoto();
    assert.notEqual(exhaustedPhoto, null);
    assert.deepEqual(await retryService.getPhotoStatus(retryContext, exhaustedPhoto!.id), {
      id: exhaustedPhoto!.id,
      status: 'failed',
      mime_type: 'image/webp',
      width: 1,
      height: 1,
      size_bytes: 1,
      expires_at: exhaustedPhoto!.expiresAt.toISOString(),
      failure_code: 'CHAT_PHOTO_INVALID',
      retry_allowed: false,
    });

    await retryService.preflightPhotoUpload(retryContext);
    await assert.rejects(
      retryService.uploadPhotoAfterPreflight(
        retryContext,
        retryConversation!.conversation.id,
        retryUploadId,
        Buffer.from('same-invalid-photo'),
      ),
      (error: unknown) => error instanceof HttpError && error.code === 'CHAT_PHOTO_RETRY_EXHAUSTED',
    );
  }

  {
    const repository = new InMemoryChatRepository();
    const clock = new FixedChatClock(new Date('2026-08-23T10:00:00.000Z'));
    const rateLimiter = new InMemoryChatRateLimiter();
    const service = createPhotoService(
      repository,
      new FakeChatMediaStore(),
      new FakeChatImageProcessor(),
      clock,
      rateLimiter,
    );
    const sessionId = randomUUID();
    repository.addSession(repository.clientId, sessionId);
    const conversation = await repository.createOrGetConversation(repository.clientId, clock.now());
    assert.notEqual(conversation, null);
    const context = { userId: repository.clientId, sessionId, ip: '127.0.0.3' };
    const directBytes = Buffer.from('direct-service-byte-accounting');
    const byteMaximum = 100 * 1024 * 1024;
    rateLimiter.consume({
      scope: 'photo_bytes_hour',
      key: `principal:${repository.clientId}`,
      maximum: byteMaximum,
      windowMs: 60 * 60 * 1000,
      cost: byteMaximum - directBytes.length,
    });

    await service.preflightPhotoUpload(context);
    assert.equal(
      (
        await service.uploadPhotoAfterPreflight(
          context,
          conversation!.conversation.id,
          randomUUID(),
          directBytes,
        )
      ).statusCode,
      201,
    );
    await service.preflightPhotoUpload(context);
    await assert.rejects(
      service.uploadPhotoAfterPreflight(
        context,
        conversation!.conversation.id,
        randomUUID(),
        Buffer.from('x'),
      ),
      (error: unknown) => error instanceof HttpError && error.code === 'CHAT_RATE_LIMITED',
      'direct service callers without a streamed admission must still pay the byte cost',
    );
  }

  console.log('KINETRA_T12_PHOTO_SECURITY=PASS');
});
