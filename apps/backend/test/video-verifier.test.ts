import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import type { VideoUploadSnapshot } from '../src/video-admin/repository.js';
import type { VideoStorage } from '../src/video-admin/storage.js';
import {
  Mp4VideoVerifier,
  VideoVerificationError,
  VideoVerificationInfrastructureError,
  VideoVerificationRuntimeError,
} from '../src/video-admin/verifier.js';

const execFileAsync = promisify(execFile);

const uploadFor = (path: string, size: number): VideoUploadSnapshot => ({
  id: '00000000-0000-4000-8000-000000000001',
  targetVideoId: '00000000-0000-4000-8000-000000000002',
  uploaderUserId: '00000000-0000-4000-8000-000000000003',
  weekNumber: 1,
  dayOfWeek: 1,
  objectKey: path,
  multipartUploadId: null,
  idempotencyKey: '00000000-0000-4000-8000-000000000004',
  requestFingerprint: 'a'.repeat(64),
  status: 'verifying',
  expectedSizeBytes: size,
  partSizeBytes: 5_242_880,
  expectedPartCount: 1,
  targetMediaRevision: 0,
  actualSizeBytes: size,
  sha256: null,
  s3Etag: 'test-etag',
  s3VersionId: null,
  durationSeconds: null,
  width: null,
  height: null,
  videoCodec: null,
  audioCodec: null,
  lastErrorCode: null,
  expiresAt: new Date('2026-08-24T18:00:00.000Z'),
  completedAt: new Date('2026-08-24T12:00:00.000Z'),
  verifiedAt: null,
  publishedAt: null,
  verificationAttemptCount: 1,
});

const fileStorage = (): VideoStorage => ({
  available: true,
  probeAccess: async () => undefined,
  createMultipart: async () => {
    throw new Error('unused');
  },
  signPart: async () => {
    throw new Error('unused');
  },
  listParts: async () => {
    throw new Error('unused');
  },
  completeMultipart: async () => {
    throw new Error('unused');
  },
  abortMultipart: async () => {
    throw new Error('unused');
  },
  headObject: async (path) => ({
    size: (await stat(path)).size,
    uploadId: '00000000-0000-4000-8000-000000000001',
    etag: 'test-etag',
    versionId: null,
    encryption: 'AES256',
    kmsKeyId: null,
  }),
  getObject: async (path) => ({
    body: createReadStream(path, { highWaterMark: 32 * 1024 }),
    contentLength: (await stat(path)).size,
  }),
  signGet: async () => {
    throw new Error('unused');
  },
  listExactObjectVersions: async () => {
    throw new Error('unused');
  },
  deleteObject: async () => {
    throw new Error('unused');
  },
});

test('T14 verifier accepts a real MP4/H.264 stream and rejects random bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kinetra-t14-verifier-test-'));
  const validPath = join(directory, 'synthetic.mp4');
  const invalidPath = join(directory, 'renamed.mp4');
  const subtitlePath = join(directory, 'subtitle.srt');
  const extraStreamPath = join(directory, 'subtitle.mp4');
  const dataStreamPath = join(directory, 'data-stream.mp4');
  const threeGpPath = join(directory, 'disguised-3gp.mp4');
  const movPath = join(directory, 'disguised-mov.mp4');
  const tooShortPath = join(directory, 'too-short.mp4');
  const tooLongFfprobePath = join(directory, 'too-long-ffprobe');
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=64x64:r=16:d=10',
        '-an',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-y',
        validPath,
      ],
      { timeout: 30_000, maxBuffer: 256 * 1024 },
    );
    await execFileAsync(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        validPath,
        '-map',
        '0:v:0',
        '-c:v',
        'copy',
        '-timecode',
        '00:00:00:00',
        '-y',
        dataStreamPath,
      ],
      { timeout: 30_000, maxBuffer: 256 * 1024 },
    );
    for (const [format, target] of [
      ['3gp', threeGpPath],
      ['mov', movPath],
    ] as const) {
      await execFileAsync(
        'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          validPath,
          '-map',
          '0:v:0',
          '-c:v',
          'copy',
          '-f',
          format,
          '-y',
          target,
        ],
        { timeout: 30_000, maxBuffer: 256 * 1024 },
      );
    }
    await execFileAsync(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=64x64:r=16:d=9.625',
        '-an',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-y',
        tooShortPath,
      ],
      { timeout: 30_000, maxBuffer: 256 * 1024 },
    );
    await writeFile(
      tooLongFfprobePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  format: { format_name: 'mov,mp4', duration: '10800.4' },
  streams: [{
    codec_type: 'video', codec_name: 'h264', width: 64, height: 64,
    avg_frame_rate: '16/1'
  }]
}));
`,
      { mode: 0o700 },
    );
    assert.equal((await readFile(validPath)).subarray(8, 12).toString('ascii'), 'isom');
    assert.equal((await readFile(threeGpPath)).subarray(8, 12).toString('ascii'), '3gp6');
    assert.equal((await readFile(movPath)).subarray(8, 12).toString('ascii'), 'qt  ');
    const tooShortProbe = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        tooShortPath,
      ],
      { timeout: 30_000, maxBuffer: 64 * 1024 },
    );
    assert.equal(Number(tooShortProbe.stdout.trim()), 9.625);
    await writeFile(invalidPath, Buffer.from('random bytes renamed to mp4', 'utf8'), {
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(subtitlePath, '1\n00:00:00,000 --> 00:00:01,000\nKinetra\n', 'utf8');
    await execFileAsync(
      'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        validPath,
        '-f',
        'srt',
        '-i',
        subtitlePath,
        '-map',
        '0:v',
        '-map',
        '1:0',
        '-c:v',
        'copy',
        '-c:s',
        'mov_text',
        '-y',
        extraStreamPath,
      ],
      { timeout: 30_000, maxBuffer: 256 * 1024 },
    );

    const verifier = new Mp4VideoVerifier(fileStorage(), 'ffprobe');
    const validSize = (await stat(validPath)).size;
    const metadata = await verifier.verify(uploadFor(validPath, validSize));
    assert.deepEqual(
      {
        durationSeconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        videoCodec: metadata.videoCodec,
        audioCodec: metadata.audioCodec,
      },
      {
        durationSeconds: 10,
        width: 64,
        height: 64,
        videoCodec: 'h264',
        audioCodec: null,
      },
    );
    assert.match(metadata.sha256, /^[0-9a-f]{64}$/u);

    const kmsStorage = {
      ...fileStorage(),
      headObject: async (path: string) => ({
        size: (await stat(path)).size,
        uploadId: '00000000-0000-4000-8000-000000000001',
        etag: 'test-etag',
        versionId: null,
        encryption: 'aws:kms',
        kmsKeyId: 'arn:aws:kms:eu-west-1:111122223333:key/test',
      }),
    } as VideoStorage;
    await new Mp4VideoVerifier(kmsStorage, 'ffprobe', undefined, {
      serverSideEncryption: 'aws:kms',
      kmsKeyId: 'arn:aws:kms:eu-west-1:111122223333:key/test',
    }).verify(uploadFor(validPath, validSize));
    for (const expectedEncryption of [
      { serverSideEncryption: 'AES256', kmsKeyId: null },
      {
        serverSideEncryption: 'aws:kms',
        kmsKeyId: 'arn:aws:kms:eu-west-1:111122223333:key/other',
      },
    ] as const) {
      await assert.rejects(
        () =>
          new Mp4VideoVerifier(kmsStorage, 'ffprobe', undefined, expectedEncryption).verify(
            uploadFor(validPath, validSize),
          ),
        (caught: unknown) =>
          caught instanceof VideoVerificationRuntimeError &&
          caught.code === 'verification_object_metadata_unconfirmed',
      );
    }

    const observedHeadVersions: (string | null | undefined)[] = [];
    const observedGetVersions: (string | null | undefined)[] = [];
    const pinnedStorage = {
      ...fileStorage(),
      headObject: async (path: string, versionId?: string | null) => {
        observedHeadVersions.push(versionId);
        return {
          size: (await stat(path)).size,
          uploadId: '00000000-0000-4000-8000-000000000001',
          etag: 'version-etag',
          versionId: 'recorded-version',
          encryption: 'AES256',
          kmsKeyId: null,
        };
      },
      getObject: async (path: string, versionId?: string | null) => {
        observedGetVersions.push(versionId);
        return {
          body: createReadStream(path, { highWaterMark: 32 * 1024 }),
          contentLength: (await stat(path)).size,
        };
      },
    } as VideoStorage;
    await new Mp4VideoVerifier(pinnedStorage, 'ffprobe').verify({
      ...uploadFor(validPath, validSize),
      s3Etag: 'version-etag',
      s3VersionId: 'recorded-version',
    });
    assert.deepEqual(observedHeadVersions, ['recorded-version']);
    assert.deepEqual(observedGetVersions, ['recorded-version']);

    const invalidSize = (await stat(invalidPath)).size;
    await assert.rejects(
      () => verifier.verify(uploadFor(invalidPath, invalidSize)),
      (caught: unknown) =>
        caught instanceof VideoVerificationError && caught.code === 'invalid_mp4_container',
    );
    for (const invalidStreamPath of [extraStreamPath, dataStreamPath]) {
      const invalidStreamSize = (await stat(invalidStreamPath)).size;
      await assert.rejects(
        () => verifier.verify(uploadFor(invalidStreamPath, invalidStreamSize)),
        (caught: unknown) =>
          caught instanceof VideoVerificationError && caught.code === 'invalid_stream_count',
      );
    }
    for (const disguisedPath of [threeGpPath, movPath]) {
      const disguisedSize = (await stat(disguisedPath)).size;
      await assert.rejects(
        () => verifier.verify(uploadFor(disguisedPath, disguisedSize)),
        (caught: unknown) =>
          caught instanceof VideoVerificationError && caught.code === 'invalid_mp4_container',
      );
    }
    const tooShortSize = (await stat(tooShortPath)).size;
    await assert.rejects(
      () => verifier.verify(uploadFor(tooShortPath, tooShortSize)),
      (caught: unknown) =>
        caught instanceof VideoVerificationError && caught.code === 'invalid_duration',
    );
    await assert.rejects(
      () =>
        new Mp4VideoVerifier(fileStorage(), tooLongFfprobePath).verify(
          uploadFor(validPath, validSize),
        ),
      (caught: unknown) =>
        caught instanceof VideoVerificationError && caught.code === 'invalid_duration',
    );
    console.log('KINETRA_T14_VIDEO_VERIFICATION=PASS');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T14 verifier propagates source and temporary write failures without hanging', async () => {
  const base = fileStorage();
  const bytes = Buffer.from('0000ftypisom0000', 'ascii');
  const head = async () => ({
    size: bytes.length,
    uploadId: '00000000-0000-4000-8000-000000000001',
    etag: 'test-etag',
    versionId: 'v1',
    encryption: 'AES256',
    kmsKeyId: null,
  });
  const sourceStorage = {
    ...base,
    headObject: head,
    getObject: async () => ({
      contentLength: bytes.length,
      body: (async function* () {
        yield bytes.subarray(0, 8);
        throw new Error('source stream failed');
      })(),
    }),
  } as VideoStorage;
  await assert.rejects(
    new Mp4VideoVerifier(sourceStorage, 'ffprobe').verify(
      uploadFor(
        'videos/workouts/week-01/day-1/00000000-0000-4000-8000-000000000001.mp4',
        bytes.length,
      ),
    ),
    (caught: unknown) =>
      caught instanceof VideoVerificationInfrastructureError &&
      caught.code === 'verification_stream_failed' &&
      caught.cause instanceof Error &&
      caught.cause.message === 'source stream failed',
  );

  const writeStorage = {
    ...base,
    headObject: head,
    getObject: async () => ({
      contentLength: bytes.length,
      body: (async function* () {
        yield bytes;
      })(),
    }),
  } as VideoStorage;
  const failingOutput = new Mp4VideoVerifier(
    writeStorage,
    'ffprobe',
    () => new Writable({ write: (_chunk, _encoding, callback) => callback(new Error('ENOSPC')) }),
  );
  await assert.rejects(
    failingOutput.verify(
      uploadFor(
        'videos/workouts/week-01/day-1/00000000-0000-4000-8000-000000000001.mp4',
        bytes.length,
      ),
    ),
    (caught: unknown) =>
      caught instanceof VideoVerificationInfrastructureError &&
      caught.code === 'verification_stream_failed' &&
      caught.cause instanceof Error &&
      caught.cause.message === 'ENOSPC',
  );
});

test('T14 unversioned verification is fenced to the ETag recorded at completion', async () => {
  const bytes = Buffer.from('0000ftypisom0000', 'ascii');
  const storage = {
    ...fileStorage(),
    headObject: async () => ({
      size: bytes.length,
      uploadId: '00000000-0000-4000-8000-000000000001',
      etag: 'replacement-etag',
      versionId: null,
      encryption: 'AES256',
      kmsKeyId: null,
    }),
    getObject: async () => ({
      contentLength: bytes.length,
      body: (async function* () {
        yield bytes;
      })(),
    }),
  } as VideoStorage;
  await assert.rejects(
    new Mp4VideoVerifier(storage, 'ffprobe').verify(
      uploadFor(
        'videos/workouts/week-01/day-1/00000000-0000-4000-8000-000000000001.mp4',
        bytes.length,
      ),
    ),
    (caught: unknown) =>
      caught instanceof VideoVerificationRuntimeError &&
      caught.code === 'verification_object_metadata_unconfirmed',
  );
});
