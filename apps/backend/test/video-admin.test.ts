import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { HttpError } from '../src/auth/errors.js';
import type { VideoUploadsEnvironment } from '../src/config/env.js';
import type { VideoAdminRepository, VideoUploadSnapshot } from '../src/video-admin/repository.js';
import { createUploadSchema, parseVideoInput, signPartsSchema } from '../src/video-admin/schema.js';
import { VideoAdminService } from '../src/video-admin/service.js';
import type { VideoStorage } from '../src/video-admin/storage.js';
import { Mp4VideoVerifier } from '../src/video-admin/verifier.js';
import {
  VideoMediaCleanupService,
  VideoUploadWorkerService,
} from '../src/video-admin/worker-service.js';
import { createProductionVideoCleanupRuntime } from '../src/video-admin/runtime.js';
import { MutableClock } from './support/test-clock.js';

const me = randomUUID();
const videoId = randomUUID();
const uploadId = randomUUID();
const checksum = `${'A'.repeat(43)}=`;
const now = new Date('2026-08-24T12:00:00.000Z');

const configuration = (enabled = true): Readonly<VideoUploadsEnvironment> => ({
  enabled,
  maxBytes: 2_147_483_648,
  partSizeBytes: 5_242_880,
  partUrlTtlSeconds: 900,
  sessionTtlSeconds: 21_600,
  maxActivePerTrainer: 3,
  ffprobePath: 'ffprobe',
  verifyLeaseSeconds: 300,
  verifyDeadlineSeconds: 900,
  verifyMaxAttempts: 8,
  workerMaxStaleSeconds: 300,
  deleteGraceSeconds: 86_400,
  serverSideEncryption: 'AES256',
  kmsKeyId: null,
});

const snapshot = (
  status: VideoUploadSnapshot['status'],
  overrides: Partial<VideoUploadSnapshot> = {},
): VideoUploadSnapshot => ({
  id: uploadId,
  targetVideoId: videoId,
  uploaderUserId: me,
  weekNumber: 1,
  dayOfWeek: 1,
  objectKey: `videos/workouts/week-01/day-1/${uploadId}.mp4`,
  multipartUploadId: 'multipart-id',
  idempotencyKey: randomUUID(),
  requestFingerprint: 'a'.repeat(64),
  status,
  expectedSizeBytes: 6_291_456,
  partSizeBytes: 5_242_880,
  expectedPartCount: 2,
  targetMediaRevision: 0,
  actualSizeBytes: null,
  sha256: null,
  s3Etag: null,
  s3VersionId: null,
  durationSeconds: null,
  width: null,
  height: null,
  videoCodec: null,
  audioCodec: null,
  lastErrorCode: null,
  expiresAt: new Date('2026-08-24T18:00:00.000Z'),
  completedAt: null,
  verifiedAt: null,
  publishedAt: null,
  verificationAttemptCount: 0,
  ...overrides,
});

const authorityRepository = (): Partial<VideoAdminRepository> => ({
  getAuthority: async () => ({ userId: me, displayName: 'Тренер' }),
});

const completionLeaseRepository = (): Partial<VideoAdminRepository> => ({
  renewCompletionLease: async () => true,
});

const availableStorage = (): Partial<VideoStorage> => ({
  available: true,
  probeAccess: async () => undefined,
});

const fakeMp4 = Buffer.from('0000ftypisom0000', 'ascii');

const writeFakeFfprobe = async (
  directory: string,
  name: string,
  verificationBody: string,
): Promise<string> => {
  const path = join(directory, name);
  await writeFile(
    path,
    `#!/usr/bin/env node
if (process.argv.includes('-version')) {
  console.log('ffprobe version fake');
  process.exit(0);
}
${verificationBody}
`,
    { mode: 0o700 },
  );
  return path;
};

const validProbeBody = `console.log(JSON.stringify({
  format: { format_name: 'mov,mp4', duration: '10' },
  streams: [{
    codec_type: 'video', codec_name: 'h264', width: 64, height: 64,
    avg_frame_rate: '30/1'
  }]
}));`;

const verifierUpload = (attempt = 1): VideoUploadSnapshot =>
  snapshot('verifying', {
    expectedSizeBytes: fakeMp4.length,
    actualSizeBytes: fakeMp4.length,
    expectedPartCount: 1,
    s3Etag: 'etag',
    s3VersionId: 'version-1',
    verificationAttemptCount: attempt,
  });

const verifierStorage = (
  body: AsyncIterable<Uint8Array> = (async function* () {
    yield fakeMp4;
  })(),
): VideoStorage =>
  ({
    ...availableStorage(),
    headObject: async () => ({
      size: fakeMp4.length,
      uploadId,
      etag: 'etag',
      versionId: 'version-1',
      encryption: 'AES256',
      kmsKeyId: null,
    }),
    getObject: async () => ({ body, contentLength: fakeMp4.length }),
  }) as VideoStorage;

const rejectsWith = async (
  operation: () => Promise<unknown>,
  statusCode: number,
  code: string,
): Promise<void> => {
  await assert.rejects(operation, (caught: unknown) => {
    assert.ok(caught instanceof HttpError);
    assert.equal(caught.statusCode, statusCode);
    assert.equal(caught.code, code);
    return true;
  });
};

test('T14 schemas reject unknown fields, invalid slots and noncanonical checksums', () => {
  for (const body of [
    { week_number: 0, day_of_week: 1, mime_type: 'video/mp4', size_bytes: 1 },
    { week_number: 1, day_of_week: 8, mime_type: 'video/mp4', size_bytes: 1 },
    { week_number: 1, day_of_week: 1, mime_type: 'video/webm', size_bytes: 1 },
    { week_number: 1, day_of_week: 1, mime_type: 'video/mp4', size_bytes: 1, user_id: me },
  ]) {
    assert.throws(
      () => parseVideoInput(createUploadSchema, body),
      (caught: unknown) =>
        caught instanceof HttpError && caught.code === 'VIDEO_UPLOAD_INVALID_REQUEST',
    );
  }

  assert.throws(
    () =>
      parseVideoInput(signPartsSchema, {
        parts: [
          { part_number: 1, checksum_sha256: checksum },
          { part_number: 1, checksum_sha256: checksum },
        ],
      }),
    /Part numbers must be unique/u,
  );
  assert.throws(
    () =>
      parseVideoInput(signPartsSchema, {
        parts: [{ part_number: 1, checksum_sha256: 'not-a-checksum' }],
      }),
    (caught: unknown) =>
      caught instanceof HttpError && caught.code === 'VIDEO_UPLOAD_INVALID_REQUEST',
  );
  assert.throws(
    () =>
      parseVideoInput(signPartsSchema, {
        parts: [{ part_number: 1, checksum_sha256: `${'A'.repeat(42)}B=` }],
      }),
    /canonical base64 SHA-256/u,
  );
});

test('T14 feature flag and worker heartbeats fail closed before upload reservation', async () => {
  let reserved = false;
  const repository = {
    ...authorityRepository(),
    workersAreFresh: async () => false,
    reserveUpload: async () => {
      reserved = true;
      return { kind: 'limit' } as const;
    },
  } as unknown as VideoAdminRepository;
  const storage = availableStorage() as VideoStorage;
  const clock = new MutableClock(now);

  await rejectsWith(
    () => new VideoAdminService(repository, storage, configuration(false), clock).getProgram(me),
    503,
    'VIDEO_UPLOADS_DISABLED',
  );
  await rejectsWith(
    () =>
      new VideoAdminService(repository, storage, configuration(), clock).createUpload(
        me,
        randomUUID(),
        { week_number: 1, day_of_week: 1, mime_type: 'video/mp4', size_bytes: 6_291_456 },
      ),
    503,
    'VIDEO_STORAGE_UNAVAILABLE',
  );
  assert.equal(reserved, false);
});

test('T14 init creates an immutable server key and redacts storage internals from its DTO', async () => {
  let reservedKey = '';
  const repository = {
    ...authorityRepository(),
    workersAreFresh: async () => true,
    reserveUpload: async (input: Parameters<VideoAdminRepository['reserveUpload']>[0]) => {
      reservedKey = input.objectKey;
      return {
        kind: 'created',
        upload: snapshot('creating', {
          id: input.uploadId,
          objectKey: input.objectKey,
          multipartUploadId: null,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          expectedSizeBytes: input.sizeBytes,
          partSizeBytes: input.partSizeBytes,
          expectedPartCount: input.partCount,
          expiresAt: input.expiresAt,
        }),
      } as const;
    },
    attachMultipart: async (_id: string, multipartId: string) =>
      snapshot('uploading', { objectKey: reservedKey, multipartUploadId: multipartId }),
    failCreating: async () => undefined,
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    createMultipart: async (input: { uploadId: string; videoId: string; objectKey: string }) => {
      assert.match(input.objectKey, /^videos\/workouts\/week-01\/day-1\/[0-9a-f-]{36}\.mp4$/u);
      assert.equal(input.videoId, videoId);
      return 'secret-multipart-id';
    },
  } as unknown as VideoStorage;

  const result = await new VideoAdminService(
    repository,
    storage,
    configuration(),
    new MutableClock(now),
  ).createUpload(me, randomUUID(), {
    week_number: 1,
    day_of_week: 1,
    mime_type: 'video/mp4',
    size_bytes: 6_291_456,
  });

  assert.equal(result.created, true);
  assert.equal(result.upload.status, 'uploading');
  const json = JSON.stringify(result);
  assert.equal(json.includes('objectKey'), false);
  assert.equal(json.includes('multipart'), false);
  assert.equal(json.includes('bucket'), false);
});

test('T14 failed S3 attach preserves the multipart ID for durable cleanup', async () => {
  let cleanupMultipartId: string | null = null;
  const repository = {
    ...authorityRepository(),
    workersAreFresh: async () => true,
    reserveUpload: async () => ({ kind: 'created', upload: snapshot('creating') }) as const,
    attachMultipart: async () => null,
    failCreating: async (_id: string, _code: string, _now: Date, multipartId: string | null) => {
      cleanupMultipartId = multipartId;
    },
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    createMultipart: async () => 'orphan-multipart-id',
    abortMultipart: async () => {
      throw new Error('transient abort failure');
    },
  } as unknown as VideoStorage;

  await rejectsWith(
    () =>
      new VideoAdminService(
        repository,
        storage,
        configuration(),
        new MutableClock(now),
      ).createUpload(me, randomUUID(), {
        week_number: 1,
        day_of_week: 1,
        mime_type: 'video/mp4',
        size_bytes: 6_291_456,
      }),
    503,
    'VIDEO_STORAGE_UNAVAILABLE',
  );
  assert.equal(cleanupMultipartId, 'orphan-multipart-id');
});

test('T14 cancel losing the verifier publish race returns an explicit conflict', async () => {
  const repository = {
    ...authorityRepository(),
    getUploadForTrainer: async () => snapshot('verifying'),
    cancelUpload: async () =>
      snapshot('published', {
        actualSizeBytes: 6_291_456,
        sha256: 'b'.repeat(64),
        verifiedAt: now,
        publishedAt: now,
      }),
  } as unknown as VideoAdminRepository;

  await rejectsWith(
    () =>
      new VideoAdminService(
        repository,
        availableStorage() as VideoStorage,
        configuration(),
        new MutableClock(now),
      ).cancel(me, uploadId),
    409,
    'VIDEO_UPLOAD_STATE_CONFLICT',
  );
});

test('T14 part signing uses the durable per-trainer batch limiter', async () => {
  const repository = {
    ...authorityRepository(),
    ...completionLeaseRepository(),
    getUploadForTrainer: async () => snapshot('uploading'),
    claimPartSignBatch: async () => 'rate_limited' as const,
  } as unknown as VideoAdminRepository;

  await rejectsWith(
    () =>
      new VideoAdminService(
        repository,
        availableStorage() as VideoStorage,
        configuration(),
        new MutableClock(now),
      ).signParts(me, uploadId, [{ part_number: 1, checksum_sha256: checksum }]),
    429,
    'VIDEO_UPLOAD_LIMIT_REACHED',
  );
});

test('T14 complete trusts S3 ListParts plus the durable checksum manifest', async () => {
  let listed = 0;
  let completed = 0;
  const repository = {
    ...authorityRepository(),
    ...completionLeaseRepository(),
    getUploadForTrainer: async () => snapshot('uploading'),
    beginCompletion: async () =>
      ({
        kind: 'claimed',
        upload: { ...snapshot('completing'), leaseToken: 'completion-lease' },
      }) as const,
    listPartManifests: async () => [
      { partNumber: 1, expectedSizeBytes: 5_242_880, checksumSha256Base64: checksum },
      { partNumber: 2, expectedSizeBytes: 1_048_576, checksumSha256Base64: checksum },
    ],
    markVerificationPending: async () =>
      snapshot('verification_pending', {
        actualSizeBytes: 6_291_456,
        completedAt: now,
      }),
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    listParts: async () => {
      listed += 1;
      return [
        { partNumber: 1, size: 5_242_880, checksumSha256: checksum, etag: 'one' },
        { partNumber: 2, size: 1_048_576, checksumSha256: checksum, etag: 'two' },
      ];
    },
    completeMultipart: async () => {
      completed += 1;
      return { etag: 'opaque-etag', versionId: 'version-1' };
    },
    headObject: async () => ({
      size: 6_291_456,
      uploadId,
      etag: 'opaque-etag',
      versionId: 'version-1',
      encryption: 'AES256',
      kmsKeyId: null,
    }),
  } as unknown as VideoStorage;

  const result = await new VideoAdminService(
    repository,
    storage,
    configuration(),
    new MutableClock(now),
  ).complete(me, uploadId);

  assert.equal(result.status, 'verification_pending');
  assert.equal(result.uploaded_bytes, 6_291_456);
  assert.equal(listed, 1);
  assert.equal(completed, 1);
});

test('T14 completion requires the configured SSE mode and exact KMS key', async () => {
  const run = async (
    encryption: string,
    kmsKeyId: string | null,
    configured: Pick<VideoUploadsEnvironment, 'serverSideEncryption' | 'kmsKeyId'>,
  ) => {
    const repository = {
      ...authorityRepository(),
      ...completionLeaseRepository(),
      getUploadForTrainer: async () => snapshot('uploading'),
      beginCompletion: async () =>
        ({
          kind: 'claimed',
          upload: { ...snapshot('completing'), leaseToken: 'completion-lease' },
        }) as const,
      listPartManifests: async () => [
        { partNumber: 1, expectedSizeBytes: 5_242_880, checksumSha256Base64: checksum },
        { partNumber: 2, expectedSizeBytes: 1_048_576, checksumSha256Base64: checksum },
      ],
      markVerificationPending: async () =>
        snapshot('verification_pending', { actualSizeBytes: 6_291_456, completedAt: now }),
    } as unknown as VideoAdminRepository;
    const storage = {
      ...availableStorage(),
      listParts: async () => [
        { partNumber: 1, size: 5_242_880, checksumSha256: checksum, etag: 'one' },
        { partNumber: 2, size: 1_048_576, checksumSha256: checksum, etag: 'two' },
      ],
      completeMultipart: async () => ({ etag: 'etag', versionId: 'version-1' }),
      headObject: async () => ({
        size: 6_291_456,
        uploadId,
        etag: 'etag',
        versionId: 'version-1',
        encryption,
        kmsKeyId,
      }),
    } as unknown as VideoStorage;
    return new VideoAdminService(
      repository,
      storage,
      { ...configuration(), ...configured },
      new MutableClock(now),
    ).complete(me, uploadId);
  };

  for (const mismatch of [
    {
      encryption: 'aws:kms',
      kmsKeyId: 'key-1',
      configured: { serverSideEncryption: 'AES256', kmsKeyId: null },
    },
    {
      encryption: 'AES256',
      kmsKeyId: null,
      configured: { serverSideEncryption: 'aws:kms', kmsKeyId: 'key-1' },
    },
    {
      encryption: 'aws:kms',
      kmsKeyId: 'key-2',
      configured: { serverSideEncryption: 'aws:kms', kmsKeyId: 'key-1' },
    },
  ] as const) {
    await rejectsWith(
      () => run(mismatch.encryption, mismatch.kmsKeyId, mismatch.configured),
      409,
      'VIDEO_UPLOAD_VERIFICATION_FAILED',
    );
  }
  assert.equal(
    (
      await run('aws:kms', 'key-1', {
        serverSideEncryption: 'aws:kms',
        kmsKeyId: 'key-1',
      })
    ).status,
    'verification_pending',
  );
});

test('T14 incomplete completion is fenced back to uploading and can resume safely', async () => {
  let state: VideoUploadSnapshot['status'] = 'uploading';
  let completionLease = 0;
  let completed = 0;
  let storedParts = [{ partNumber: 1, size: 5_242_880, checksumSha256: checksum, etag: 'one' }];
  const manifests = [
    { partNumber: 1, expectedSizeBytes: 5_242_880, checksumSha256Base64: checksum },
  ];
  const repository = {
    ...authorityRepository(),
    ...completionLeaseRepository(),
    getUploadForTrainer: async () => snapshot(state),
    beginCompletion: async () => {
      if (state !== 'uploading') return { kind: 'state_conflict' } as const;
      state = 'completing';
      completionLease += 1;
      return {
        kind: 'claimed',
        upload: { ...snapshot('completing'), leaseToken: `lease-${completionLease}` },
      } as const;
    },
    listPartManifests: async () => manifests,
    releaseCompletion: async (_id: string, token: string) => {
      if (state !== 'completing' || token !== `lease-${completionLease}`) return null;
      state = 'uploading';
      return snapshot('uploading');
    },
    claimPartSignBatch: async () => 'allowed' as const,
    savePartManifest: async (input: Parameters<VideoAdminRepository['savePartManifest']>[0]) => {
      manifests.push({
        partNumber: input.partNumber,
        expectedSizeBytes: input.expectedSizeBytes,
        checksumSha256Base64: input.checksumSha256Base64,
      });
      return 'created' as const;
    },
    markVerificationPending: async (input: { readonly leaseToken: string }) => {
      if (state !== 'completing' || input.leaseToken !== `lease-${completionLease}`) return null;
      state = 'verification_pending';
      return snapshot('verification_pending', { actualSizeBytes: 6_291_456 });
    },
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    listParts: async () => storedParts,
    signPart: async () => 'https://private-s3.test/missing-part',
    completeMultipart: async () => {
      completed += 1;
      return { etag: 'etag', versionId: 'version-1' };
    },
    headObject: async () => ({
      size: 6_291_456,
      uploadId,
      etag: 'etag',
      versionId: 'version-1',
      encryption: 'AES256',
      kmsKeyId: null,
    }),
  } as unknown as VideoStorage;
  const service = new VideoAdminService(
    repository,
    storage,
    configuration(),
    new MutableClock(now),
  );

  await rejectsWith(() => service.complete(me, uploadId), 409, 'VIDEO_UPLOAD_INCOMPLETE');
  assert.equal(state, 'uploading');
  const signed = await service.signParts(me, uploadId, [
    { part_number: 2, checksum_sha256: checksum },
  ]);
  assert.equal(signed[0]?.part_number, 2);
  storedParts = [
    ...storedParts,
    { partNumber: 2, size: 1_048_576, checksumSha256: checksum, etag: 'two' },
  ];
  const accepted = await service.complete(me, uploadId);
  assert.equal(accepted.status, 'verification_pending');
  assert.equal(completed, 1);
});

test('T14 ambiguous S3 completion never reopens multipart signing', async () => {
  let releases = 0;
  const repository = {
    ...authorityRepository(),
    ...completionLeaseRepository(),
    getUploadForTrainer: async () => snapshot('uploading'),
    beginCompletion: async () =>
      ({
        kind: 'claimed',
        upload: { ...snapshot('completing'), leaseToken: 'owner' },
      }) as const,
    listPartManifests: async () => [
      { partNumber: 1, expectedSizeBytes: 5_242_880, checksumSha256Base64: checksum },
      { partNumber: 2, expectedSizeBytes: 1_048_576, checksumSha256Base64: checksum },
    ],
    releaseCompletion: async () => {
      releases += 1;
      return snapshot('uploading');
    },
  } as unknown as VideoAdminRepository;
  let headCalls = 0;
  const storage = {
    ...availableStorage(),
    listParts: async () => [
      { partNumber: 1, size: 5_242_880, checksumSha256: checksum, etag: 'one' },
      { partNumber: 2, size: 1_048_576, checksumSha256: checksum, etag: 'two' },
    ],
    completeMultipart: async () => {
      throw new Error('S3 response lost');
    },
    headObject: async () => {
      headCalls += 1;
      return null;
    },
  } as unknown as VideoStorage;

  await rejectsWith(
    () =>
      new VideoAdminService(repository, storage, configuration(), new MutableClock(now)).complete(
        me,
        uploadId,
      ),
    503,
    'VIDEO_STORAGE_UNAVAILABLE',
  );
  assert.equal(releases, 0);
  assert.equal(headCalls, 1);
});

test('T14 transient ListParts, manifest DB and completion-state DB errors reconcile safely', async () => {
  for (const stage of ['list', 'manifests', 'mark'] as const) {
    let releases = 0;
    let completes = 0;
    let reads = 0;
    const repository = {
      ...authorityRepository(),
      ...completionLeaseRepository(),
      getUploadForTrainer: async () => {
        reads += 1;
        return snapshot(reads === 1 ? 'uploading' : 'completing');
      },
      beginCompletion: async () =>
        ({
          kind: 'claimed',
          upload: { ...snapshot('completing'), leaseToken: 'owner' },
        }) as const,
      listPartManifests: async () => {
        if (stage === 'manifests') throw new Error('transient manifest DB failure');
        return [
          { partNumber: 1, expectedSizeBytes: 5_242_880, checksumSha256Base64: checksum },
          { partNumber: 2, expectedSizeBytes: 1_048_576, checksumSha256Base64: checksum },
        ];
      },
      releaseCompletion: async () => {
        releases += 1;
        return snapshot('uploading');
      },
      markVerificationPending: async () => {
        if (stage === 'mark') throw new Error('transient completion DB failure');
        return snapshot('verification_pending');
      },
    } as unknown as VideoAdminRepository;
    let heads = 0;
    const storage = {
      ...availableStorage(),
      listParts: async () => {
        if (stage === 'list') throw new Error('transient S3 ListParts failure');
        return [
          { partNumber: 1, size: 5_242_880, checksumSha256: checksum, etag: 'one' },
          { partNumber: 2, size: 1_048_576, checksumSha256: checksum, etag: 'two' },
        ];
      },
      completeMultipart: async () => {
        completes += 1;
        return { etag: 'etag', versionId: 'version-1' };
      },
      headObject: async () => {
        heads += 1;
        return stage === 'mark'
          ? {
              size: 6_291_456,
              uploadId,
              etag: 'etag',
              versionId: 'version-1',
              encryption: 'AES256',
              kmsKeyId: null,
            }
          : null;
      },
    } as unknown as VideoStorage;
    const service = new VideoAdminService(
      repository,
      storage,
      configuration(),
      new MutableClock(now),
    );
    if (stage === 'mark') {
      const accepted = await service.complete(me, uploadId);
      assert.equal(accepted.status, 'completing');
      assert.equal(completes, 1);
      assert.equal(heads, 1);
    } else {
      await rejectsWith(() => service.complete(me, uploadId), 503, 'VIDEO_STORAGE_UNAVAILABLE');
      assert.equal(completes, 0);
      assert.equal(heads, 1);
    }
    assert.equal(releases, 0);
  }
});

test('T14 concurrent complete is single-flight and an in-progress caller does no S3 work', async () => {
  let claims = 0;
  let listCalls = 0;
  let manifestCalls = 0;
  let completionCalls = 0;
  let headCalls = 0;
  let markCalls = 0;
  let leaseRenewals = 0;
  let current = snapshot('uploading');
  let releaseWinner!: () => void;
  const winnerFinished = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  const repository = {
    ...authorityRepository(),
    ...completionLeaseRepository(),
    renewCompletionLease: async (_id: string, token: string) => {
      assert.equal(token, 'owner');
      leaseRenewals += 1;
      return true;
    },
    getUploadForTrainer: async () => current,
    beginCompletion: async () => {
      claims += 1;
      if (claims === 1) {
        current = snapshot('completing');
        return {
          kind: 'claimed',
          upload: { ...current, leaseToken: 'owner' },
        } as const;
      }
      await winnerFinished;
      return { kind: 'in_progress', upload: current } as const;
    },
    listPartManifests: async () => {
      manifestCalls += 1;
      return [
        { partNumber: 1, expectedSizeBytes: 5_242_880, checksumSha256Base64: checksum },
        { partNumber: 2, expectedSizeBytes: 1_048_576, checksumSha256Base64: checksum },
      ];
    },
    markVerificationPending: async (input: { readonly leaseToken: string }) => {
      markCalls += 1;
      assert.equal(input.leaseToken, 'owner');
      current = snapshot('verification_pending', { actualSizeBytes: 6_291_456 });
      releaseWinner();
      return current;
    },
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    listParts: async () => {
      listCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 45));
      return [
        { partNumber: 1, size: 5_242_880, checksumSha256: checksum, etag: 'one' },
        { partNumber: 2, size: 1_048_576, checksumSha256: checksum, etag: 'two' },
      ];
    },
    completeMultipart: async () => {
      completionCalls += 1;
      return { etag: 'etag', versionId: 'v1' };
    },
    headObject: async () => {
      headCalls += 1;
      return {
        size: 6_291_456,
        uploadId,
        etag: 'etag',
        versionId: 'v1',
        encryption: 'AES256',
        kmsKeyId: null,
      };
    },
  } as unknown as VideoStorage;
  const service = new VideoAdminService(
    repository,
    storage,
    { ...configuration(), verifyLeaseSeconds: 0.03, verifyDeadlineSeconds: 1 },
    new MutableClock(now),
  );
  const results = await Promise.all(
    Array.from({ length: 50 }, () => service.complete(me, uploadId)),
  );
  assert.equal(results.length, 50);
  assert.equal(
    results.every((result) => completionAcceptedForTest(result.status)),
    true,
  );
  assert.equal(listCalls, 1);
  assert.equal(manifestCalls, 1);
  assert.equal(completionCalls, 1);
  assert.equal(headCalls, 1);
  assert.equal(markCalls, 1);
  assert.ok(leaseRenewals >= 2, 'The completion lease must renew during a slow preflight.');
});

test('T14 lost completion lease fences the stale claimant before the S3 side effect', async () => {
  let reads = 0;
  let completions = 0;
  let marks = 0;
  const repository = {
    ...authorityRepository(),
    getUploadForTrainer: async () => {
      reads += 1;
      return snapshot(reads === 1 ? 'uploading' : 'completing');
    },
    beginCompletion: async () =>
      ({
        kind: 'claimed',
        upload: { ...snapshot('completing'), leaseToken: 'stale-owner' },
      }) as const,
    renewCompletionLease: async () => false,
    listPartManifests: async () => [
      { partNumber: 1, expectedSizeBytes: 5_242_880, checksumSha256Base64: checksum },
      { partNumber: 2, expectedSizeBytes: 1_048_576, checksumSha256Base64: checksum },
    ],
    markVerificationPending: async () => {
      marks += 1;
      return null;
    },
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    listParts: async () => [
      { partNumber: 1, size: 5_242_880, checksumSha256: checksum, etag: 'one' },
      { partNumber: 2, size: 1_048_576, checksumSha256: checksum, etag: 'two' },
    ],
    completeMultipart: async () => {
      completions += 1;
      return { etag: 'etag', versionId: 'version-1' };
    },
    headObject: async () => null,
  } as unknown as VideoStorage;

  const accepted = await new VideoAdminService(
    repository,
    storage,
    configuration(),
    new MutableClock(now),
  ).complete(me, uploadId);
  assert.equal(accepted.status, 'completing');
  assert.equal(completions, 0);
  assert.equal(marks, 0);
});

test('T14 completion deadline expiring during lease renewal prevents S3 completion', async () => {
  let reads = 0;
  let completions = 0;
  const repository = {
    ...authorityRepository(),
    getUploadForTrainer: async () => {
      reads += 1;
      return snapshot(reads === 1 ? 'uploading' : 'completing');
    },
    beginCompletion: async () =>
      ({
        kind: 'claimed',
        upload: { ...snapshot('completing'), leaseToken: 'slow-renewal' },
      }) as const,
    renewCompletionLease: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return true;
    },
    listPartManifests: async () => [
      { partNumber: 1, expectedSizeBytes: 5_242_880, checksumSha256Base64: checksum },
      { partNumber: 2, expectedSizeBytes: 1_048_576, checksumSha256Base64: checksum },
    ],
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    listParts: async () => [
      { partNumber: 1, size: 5_242_880, checksumSha256: checksum, etag: 'one' },
      { partNumber: 2, size: 1_048_576, checksumSha256: checksum, etag: 'two' },
    ],
    completeMultipart: async () => {
      completions += 1;
      return { etag: 'etag', versionId: 'version-1' };
    },
    headObject: async () => null,
  } as unknown as VideoStorage;

  const accepted = await new VideoAdminService(
    repository,
    storage,
    { ...configuration(), verifyDeadlineSeconds: 0.05 },
    new MutableClock(now),
  ).complete(me, uploadId);
  assert.equal(accepted.status, 'completing');
  assert.equal(completions, 0);
});

test('T14 completion deadline aborts active S3 without reopening the multipart upload', async () => {
  let aborted = false;
  let releases = 0;
  let marks = 0;
  const repository = {
    ...authorityRepository(),
    getUploadForTrainer: async () => snapshot('uploading'),
    beginCompletion: async () =>
      ({
        kind: 'claimed',
        upload: { ...snapshot('completing'), leaseToken: 'deadline-owner' },
      }) as const,
    renewCompletionLease: async () => true,
    listPartManifests: async () => [
      { partNumber: 1, expectedSizeBytes: 5_242_880, checksumSha256Base64: checksum },
      { partNumber: 2, expectedSizeBytes: 1_048_576, checksumSha256Base64: checksum },
    ],
    releaseCompletion: async () => {
      releases += 1;
      return snapshot('uploading');
    },
    markVerificationPending: async () => {
      marks += 1;
      return snapshot('verification_pending');
    },
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    listParts: async () => [
      { partNumber: 1, size: 5_242_880, checksumSha256: checksum, etag: 'one' },
      { partNumber: 2, size: 1_048_576, checksumSha256: checksum, etag: 'two' },
    ],
    completeMultipart: async (
      _key: string,
      _multipart: string,
      _parts: readonly unknown[],
      signal?: AbortSignal,
    ) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    headObject: async () => null,
  } as unknown as VideoStorage;

  await rejectsWith(
    () =>
      new VideoAdminService(
        repository,
        storage,
        { ...configuration(), verifyLeaseSeconds: 0.03, verifyDeadlineSeconds: 0.05 },
        new MutableClock(now),
      ).complete(me, uploadId),
    503,
    'VIDEO_STORAGE_UNAVAILABLE',
  );
  assert.equal(aborted, true);
  assert.equal(releases, 0);
  assert.equal(marks, 0);
});

const completionAcceptedForTest = (status: VideoUploadSnapshot['status']): boolean =>
  ['completing', 'verification_pending', 'verifying', 'published'].includes(status);

test('T14 stale completion claimant reconciles the winner instead of returning a false conflict', async () => {
  let reads = 0;
  const repository = {
    ...authorityRepository(),
    ...completionLeaseRepository(),
    getUploadForTrainer: async () => {
      reads += 1;
      return reads === 1 ? snapshot('uploading') : snapshot('published');
    },
    beginCompletion: async () =>
      ({
        kind: 'claimed',
        upload: { ...snapshot('completing'), leaseToken: 'stale-token' },
      }) as const,
    listPartManifests: async () => [
      { partNumber: 1, expectedSizeBytes: 5_242_880, checksumSha256Base64: checksum },
      { partNumber: 2, expectedSizeBytes: 1_048_576, checksumSha256Base64: checksum },
    ],
    markVerificationPending: async () => null,
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    listParts: async () => [
      { partNumber: 1, size: 5_242_880, checksumSha256: checksum, etag: 'one' },
      { partNumber: 2, size: 1_048_576, checksumSha256: checksum, etag: 'two' },
    ],
    completeMultipart: async () => ({ etag: 'etag', versionId: 'version-1' }),
    headObject: async () => ({
      size: 6_291_456,
      uploadId,
      etag: 'etag',
      versionId: 'version-1',
      encryption: 'AES256',
      kmsKeyId: null,
    }),
  } as unknown as VideoStorage;

  const result = await new VideoAdminService(
    repository,
    storage,
    configuration(),
    new MutableClock(now),
  ).complete(me, uploadId);
  assert.equal(result.status, 'published');
});

test('T14 preview URL is pinned to the published S3 VersionId', async () => {
  let signedVersion: string | null | undefined;
  const repository = {
    ...authorityRepository(),
    getPreviewObject: async () => ({
      objectKey: `videos/workouts/week-01/day-1/${uploadId}.mp4`,
      versionId: 'published-version',
      etag: 'published-etag',
    }),
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    signGet: async (_key: string, _ttl: number, versionId?: string | null) => {
      signedVersion = versionId;
      return 'https://private-s3.test/versioned';
    },
  } as unknown as VideoStorage;
  const result = await new VideoAdminService(
    repository,
    storage,
    configuration(),
    new MutableClock(now),
  ).preview(me, videoId);
  assert.equal(result.url, 'https://private-s3.test/versioned');
  assert.equal(signedVersion, 'published-version');
});

test('T14 unversioned preview refuses a current object that no longer matches published ETag', async () => {
  let signed = false;
  const repository = {
    ...authorityRepository(),
    getPreviewObject: async () => ({
      objectKey: `videos/workouts/week-01/day-1/${uploadId}.mp4`,
      versionId: null,
      etag: 'verified-etag',
    }),
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    headObject: async () => ({
      size: 6_291_456,
      uploadId,
      etag: 'overwritten-etag',
      versionId: null,
      encryption: 'AES256',
      kmsKeyId: null,
    }),
    signGet: async () => {
      signed = true;
      return 'https://private-s3.test/unversioned';
    },
  } as unknown as VideoStorage;

  await rejectsWith(
    () =>
      new VideoAdminService(repository, storage, configuration(), new MutableClock(now)).preview(
        me,
        videoId,
      ),
    409,
    'VIDEO_UPLOAD_VERIFICATION_FAILED',
  );
  assert.equal(signed, false);
});

test('T14 cleanup never deletes a key still referenced by a workout', async () => {
  let deleted = false;
  let completed = false;
  let retried = false;
  const repository = {
    claimDeletionJobs: async () => [
      {
        id: randomUUID(),
        objectKey: `videos/workouts/week-01/day-1/${randomUUID()}.mp4`,
        versionId: null,
        multipartUploadId: null,
        attemptCount: 1,
      },
    ],
    isObjectReferenced: async () => true,
    completeDeletion: async () => {
      completed = true;
    },
    retryDeletion: async (_jobId: string, errorCode: string) => {
      assert.equal(errorCode, 'object_still_referenced');
      retried = true;
    },
    finalizeCleanupRun: async () => true,
    updateHeartbeat: async () => undefined,
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    deleteObject: async () => {
      deleted = true;
    },
  } as unknown as VideoStorage;

  const result = await new VideoMediaCleanupService(
    repository,
    storage,
    new MutableClock(now),
  ).runOnce();

  assert.deepEqual(result, { completed: 0, retried: 1 });
  assert.equal(completed, false);
  assert.equal(retried, true);
  assert.equal(deleted, false);
});

test('T14 cleanup reconciles every exact orphan version before acknowledging the job', async () => {
  const objectKey = `videos/workouts/week-01/day-1/${randomUUID()}.mp4`;
  const deletedVersions: (string | null)[] = [];
  let listed = 0;
  let completed = false;
  const repository = {
    claimDeletionJobs: async () => [
      {
        id: randomUUID(),
        objectKey,
        versionId: null,
        multipartUploadId: null,
        attemptCount: 1,
      },
    ],
    isObjectReferenced: async () => false,
    completeDeletion: async () => {
      completed = true;
    },
    retryDeletion: async () => undefined,
    finalizeCleanupRun: async () => true,
    updateHeartbeat: async () => undefined,
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    listExactObjectVersions: async () => (listed++ === 0 ? ['version-1', 'delete-marker-1'] : []),
    deleteObject: async (_key: string, versionId: string | null) => {
      deletedVersions.push(versionId);
    },
    headObject: async () => null,
  } as unknown as VideoStorage;

  const result = await new VideoMediaCleanupService(
    repository,
    storage,
    new MutableClock(now),
  ).runOnce();

  assert.deepEqual(result, { completed: 1, retried: 0 });
  assert.deepEqual(deletedVersions, ['version-1', 'delete-marker-1']);
  assert.equal(completed, true);
});

test('T14 cleanup acknowledges an already absent versioned object without creating a marker', async () => {
  const objectKey = `videos/workouts/week-01/day-1/${randomUUID()}.mp4`;
  let deleted = 0;
  let completed = 0;
  let retried = 0;
  const repository = {
    claimDeletionJobs: async () => [
      {
        id: randomUUID(),
        objectKey,
        versionId: null,
        multipartUploadId: null,
        attemptCount: 1,
      },
    ],
    isObjectReferenced: async () => false,
    completeDeletion: async () => {
      completed += 1;
    },
    retryDeletion: async () => {
      retried += 1;
    },
    finalizeCleanupRun: async (_at: Date, degraded: boolean) => !degraded,
    updateHeartbeat: async () => undefined,
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    listExactObjectVersions: async () => [],
    headObject: async () => null,
    deleteObject: async () => {
      deleted += 1;
      throw new Error('An absent key must not receive a delete marker.');
    },
  } as unknown as VideoStorage;

  assert.deepEqual(
    await new VideoMediaCleanupService(repository, storage, new MutableClock(now)).runOnce(),
    { completed: 1, retried: 0 },
  );
  assert.equal(deleted, 0);
  assert.equal(completed, 1);
  assert.equal(retried, 0);
});

test('T14 cleanup deadline bounds every storage operation and durably records failure', async () => {
  for (const stage of ['abort', 'list', 'head', 'delete', 'post-delete'] as const) {
    const objectKey = `videos/workouts/week-01/day-1/${randomUUID()}.mp4`;
    let retried = 0;
    let completed = 0;
    let heartbeat: string | null = null;
    let observedSignal: AbortSignal | undefined;
    const versionId = stage === 'list' || stage === 'head' ? null : 'version-1';
    const repository = {
      claimDeletionJobs: async () => [
        {
          id: randomUUID(),
          objectKey,
          versionId,
          multipartUploadId: stage === 'abort' ? 'multipart-1' : null,
          attemptCount: 1,
        },
      ],
      isObjectReferenced: async () => false,
      completeDeletion: async () => {
        completed += 1;
      },
      retryDeletion: async (_jobId: string, errorCode: string) => {
        assert.equal(errorCode, 'object_cleanup_failed');
        retried += 1;
      },
      finalizeCleanupRun: async (_at: Date, degraded: boolean) => {
        heartbeat = degraded ? 'failed' : 'succeeded';
        return !degraded;
      },
      updateHeartbeat: async (_worker: string, result: string) => {
        if (result === 'failed') heartbeat = result;
      },
    } as unknown as VideoAdminRepository;
    const hang = (signal?: AbortSignal): Promise<never> => {
      observedSignal = signal;
      return new Promise<never>(() => undefined);
    };
    let lists = 0;
    const storage = {
      ...availableStorage(),
      abortMultipart: async (_key: string, _upload: string, signal?: AbortSignal) =>
        stage === 'abort' ? hang(signal) : undefined,
      listExactObjectVersions: async (_key: string, signal?: AbortSignal) => {
        lists += 1;
        if (stage === 'list' || (stage === 'post-delete' && lists === 1)) return hang(signal);
        return [];
      },
      headObject: async (_key: string, _version?: string | null, signal?: AbortSignal) =>
        stage === 'head' ? hang(signal) : null,
      deleteObject: async (_key: string, _version: string | null, signal?: AbortSignal) =>
        stage === 'delete' ? hang(signal) : undefined,
    } as unknown as VideoStorage;

    await assert.rejects(
      new VideoMediaCleanupService(repository, storage, new MutableClock(now), 0.05).runOnce(),
      /degraded/u,
    );
    assert.equal(observedSignal?.aborted, true, `${stage} did not receive the deadline signal`);
    assert.equal(retried, 1, `${stage} did not schedule a durable retry`);
    assert.equal(completed, 0, `${stage} incorrectly acknowledged deletion`);
    assert.equal(heartbeat, 'failed', `${stage} incorrectly reported a healthy worker`);
  }
});

test('T14 verifier metadata drift is retryable and never enters the deletion path', async () => {
  const cases = [
    {
      name: 'upload-id',
      upload: verifierUpload(),
      head: { uploadId: randomUUID(), etag: 'etag', versionId: 'version-1' },
      encryption: { encryption: 'AES256', kmsKeyId: null },
    },
    {
      name: 'version-id',
      upload: verifierUpload(),
      head: { uploadId, etag: 'etag', versionId: 'replacement-version' },
      encryption: { encryption: 'AES256', kmsKeyId: null },
    },
    {
      name: 'etag',
      upload: { ...verifierUpload(), s3VersionId: null },
      head: { uploadId, etag: 'replacement-etag', versionId: null },
      encryption: { encryption: 'AES256', kmsKeyId: null },
    },
    {
      name: 'encryption-mode',
      upload: verifierUpload(),
      head: { uploadId, etag: 'etag', versionId: 'version-1' },
      encryption: { encryption: 'aws:kms', kmsKeyId: 'wrong-key' },
    },
    {
      name: 'metadata-exhausted',
      upload: verifierUpload(8),
      head: { uploadId: randomUUID(), etag: 'etag', versionId: 'version-1' },
      encryption: { encryption: 'AES256', kmsKeyId: null },
    },
  ] as const;
  for (const scenario of cases) {
    let claimed = false;
    let retried = 0;
    let terminal = 0;
    let published = 0;
    let quarantined = 0;
    const repository = {
      claimVerification: async () => {
        if (claimed) return null;
        claimed = true;
        return { ...scenario.upload, leaseToken: 'lease' };
      },
      renewVerificationLease: async () => true,
      retryVerification: async (_id: string, token: string, code: string) => {
        assert.equal(token, 'lease');
        assert.equal(code, 'verification_transient_failure');
        retried += 1;
        return true;
      },
      failVerification: async () => {
        terminal += 1;
      },
      quarantineVerification: async () => {
        quarantined += 1;
        return true;
      },
      publishVerified: async () => {
        published += 1;
        return 'published' as const;
      },
      expireUploads: async () => 0,
      finalizeVerificationRun: async (_at: Date, degraded: boolean) => !degraded,
      updateHeartbeat: async () => undefined,
    } as unknown as VideoAdminRepository;
    const storage = {
      ...availableStorage(),
      headObject: async () => ({
        size: fakeMp4.length,
        ...scenario.head,
        ...scenario.encryption,
      }),
      getObject: async () => ({
        contentLength: fakeMp4.length,
        body: (async function* () {
          yield fakeMp4;
        })(),
      }),
    } as unknown as VideoStorage;

    await assert.rejects(
      new VideoUploadWorkerService(
        repository,
        storage,
        configuration(),
        new MutableClock(now),
      ).runOnce(),
      /degraded/u,
    );
    const exhausted = scenario.upload.verificationAttemptCount >= configuration().verifyMaxAttempts;
    assert.equal(retried, exhausted ? 0 : 1, `${scenario.name} retry outcome was incorrect`);
    assert.equal(quarantined, exhausted ? 1 : 0, `${scenario.name} quarantine was incorrect`);
    assert.equal(terminal, 0, `${scenario.name} entered terminal deletion path`);
    assert.equal(published, 0, `${scenario.name} was published`);
  }
});

test('T14 transient verifier storage failure is retryable and never deletes the valid upload', async () => {
  let retried = false;
  let terminal = false;
  let heartbeat: string | null = null;
  let claimed = false;
  const repository = {
    claimVerification: async () => {
      if (claimed) return null;
      claimed = true;
      return { ...verifierUpload(), leaseToken: 'lease' };
    },
    renewVerificationLease: async () => true,
    retryVerification: async (_id: string, token: string, code: string) => {
      assert.equal(token, 'lease');
      assert.equal(code, 'verification_transient_failure');
      retried = true;
      return true;
    },
    failVerification: async () => {
      terminal = true;
    },
    expireUploads: async () => 0,
    finalizeVerificationRun: async (_at: Date, encounteredFailure: boolean) => {
      heartbeat = encounteredFailure ? 'failed' : 'succeeded';
      return !encounteredFailure;
    },
    updateHeartbeat: async (_worker: string, result: string) => {
      heartbeat = result;
    },
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    headObject: async () => {
      throw new Error('transient S3 outage');
    },
  } as unknown as VideoStorage;
  await assert.rejects(
    new VideoUploadWorkerService(
      repository,
      storage,
      configuration(),
      new MutableClock(now),
    ).runOnce(),
    /degraded/u,
  );
  assert.equal(retried, true);
  assert.equal(terminal, false);
  assert.equal(heartbeat, 'failed');
});

test('T14 transient GetObject, body truncation and retry DB failures never delete media', async () => {
  for (const stage of ['get', 'body', 'retry-db'] as const) {
    let claimed = false;
    let terminal = false;
    let published = false;
    let retryCalls = 0;
    const repository = {
      claimVerification: async () => {
        if (claimed) return null;
        claimed = true;
        return { ...verifierUpload(), leaseToken: 'lease' };
      },
      renewVerificationLease: async () => true,
      publishVerified: async () => {
        published = true;
        return 'published' as const;
      },
      failVerification: async () => {
        terminal = true;
      },
      retryVerification: async () => {
        retryCalls += 1;
        if (stage === 'retry-db') throw new Error('transient retry scheduling DB failure');
        return true;
      },
      quarantineVerification: async () => false,
      expireUploads: async () => 0,
      finalizeVerificationRun: async (_at: Date, failure: boolean) => !failure,
      updateHeartbeat: async () => undefined,
    } as unknown as VideoAdminRepository;
    const storage = {
      ...verifierStorage(),
      ...(stage === 'retry-db'
        ? { headObject: async () => Promise.reject(new Error('transient HEAD failure')) }
        : {
            getObject: async () => {
              if (stage === 'get') throw new Error('transient GetObject failure');
              return {
                contentLength: fakeMp4.length,
                body: (async function* () {
                  yield fakeMp4.subarray(0, 8);
                })(),
              };
            },
          }),
    } as VideoStorage;
    await assert.rejects(
      new VideoUploadWorkerService(
        repository,
        storage,
        configuration(),
        new MutableClock(now),
      ).runOnce(),
    );
    assert.equal(retryCalls, 1);
    assert.equal(terminal, false);
    assert.equal(published, false);
  }
});

test('T14 stalled verifier body is aborted by the deadline and safely rescheduled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let retried = false;
  let claimed = false;
  let bodyStarted = false;
  let bodyAborted = false;
  let markBodyStarted: (() => void) | null = null;
  const bodyReady = new Promise<void>((resolve) => {
    markBodyStarted = resolve;
  });
  const repository = {
    claimVerification: async () => {
      if (claimed) return null;
      claimed = true;
      return { ...verifierUpload(), leaseToken: 'lease' };
    },
    renewVerificationLease: async () => true,
    retryVerification: async () => {
      retried = true;
      return true;
    },
    failVerification: async () => undefined,
    expireUploads: async () => 0,
    finalizeVerificationRun: async (_at: Date, encounteredFailure: boolean) => !encounteredFailure,
    updateHeartbeat: async () => undefined,
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    headObject: async () => ({
      size: fakeMp4.length,
      uploadId,
      etag: 'etag',
      versionId: 'version-1',
      encryption: 'AES256',
      kmsKeyId: null,
    }),
    getObject: async (_key: string, _version: string | null | undefined, signal?: AbortSignal) => {
      signal?.addEventListener(
        'abort',
        () => {
          bodyAborted = true;
        },
        { once: true },
      );
      return {
        contentLength: fakeMp4.length,
        body: (async function* () {
          bodyStarted = true;
          yield fakeMp4.subarray(0, 8);
          await new Promise<never>((_resolve, reject) => {
            const abort = (): void => reject(signal?.reason);
            if (signal?.aborted === true) abort();
            else signal?.addEventListener('abort', abort, { once: true });
            markBodyStarted?.();
          });
        })(),
      };
    },
  } as unknown as VideoStorage;
  try {
    const run = new VideoUploadWorkerService(
      repository,
      storage,
      { ...configuration(), verifyDeadlineSeconds: 1 },
      new MutableClock(now),
    ).runOnce();
    await Promise.race([
      bodyReady,
      run.then(
        () => Promise.reject(new Error('Worker exited before entering the body stream.')),
        (caught: unknown) => Promise.reject(caught),
      ),
    ]);
    t.mock.timers.tick(1_000);
    await assert.rejects(run, /degraded/u);
    assert.equal(retried, true);
    assert.equal(bodyStarted, true);
    assert.equal(bodyAborted, true);
  } finally {
    t.mock.timers.reset();
  }
});

test('T14 ffprobe exit, signal, malformed output and forced abort are retryable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kinetra-t14-fake-ffprobe-'));
  try {
    const scripts = [
      await writeFakeFfprobe(directory, 'exit-one', 'process.exit(1);'),
      await writeFakeFfprobe(directory, 'signal', "process.kill(process.pid, 'SIGTERM');"),
      await writeFakeFfprobe(directory, 'malformed-output', "console.log('{}');"),
      await writeFakeFfprobe(
        directory,
        'ignore-term',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);",
      ),
    ];
    for (const ffprobePath of scripts) {
      let claimed = false;
      let state: VideoUploadSnapshot['status'] = 'verifying';
      let terminal = false;
      let published = false;
      const repository = {
        claimVerification: async () => {
          if (claimed) return null;
          claimed = true;
          return { ...verifierUpload(), leaseToken: 'lease' };
        },
        renewVerificationLease: async () => true,
        publishVerified: async () => {
          published = true;
          return 'published' as const;
        },
        failVerification: async () => {
          terminal = true;
        },
        retryVerification: async () => {
          state = 'verification_pending';
          return true;
        },
        quarantineVerification: async () => false,
        expireUploads: async () => 0,
        finalizeVerificationRun: async (_at: Date, failure: boolean) => !failure,
        updateHeartbeat: async () => undefined,
      } as unknown as VideoAdminRepository;

      await assert.rejects(
        new VideoUploadWorkerService(
          repository,
          verifierStorage(),
          { ...configuration(), ffprobePath, verifyDeadlineSeconds: 0.1 },
          new MutableClock(now),
        ).runOnce(),
        /degraded/u,
      );
      assert.equal(state, 'verification_pending');
      assert.equal(terminal, false);
      assert.equal(published, false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T14 unresolved verifier infrastructure outage cannot recover on an empty run', async () => {
  let claimed = false;
  let probeFails = false;
  let terminal = false;
  let quarantinedCode: string | null = null;
  let healthyFinalizations = 0;
  const repository = {
    claimVerification: async () => {
      if (claimed) return null;
      claimed = true;
      return {
        ...verifierUpload(configuration().verifyMaxAttempts),
        leaseToken: 'infrastructure-lease',
      };
    },
    renewVerificationLease: async () => true,
    publishVerified: async () => 'published' as const,
    failVerification: async () => {
      terminal = true;
    },
    retryVerification: async () => false,
    quarantineVerification: async (_id: string, _token: string, code: string) => {
      quarantinedCode = code;
      return true;
    },
    expireUploads: async () => 0,
    finalizeVerificationRun: async (_at: Date, failure: boolean) => {
      if (!failure) healthyFinalizations += 1;
      return !failure;
    },
    updateHeartbeat: async () => undefined,
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    probeAccess: async () => {
      if (probeFails) throw new Error('persistent S3 access outage');
    },
    headObject: async () => {
      throw new Error('transient S3 HEAD outage');
    },
  } as unknown as VideoStorage;
  const worker = new VideoUploadWorkerService(
    repository,
    storage,
    configuration(),
    new MutableClock(now),
  );

  await assert.rejects(worker.runOnce(), /degraded/u);
  assert.equal(quarantinedCode, 'verification_infrastructure_exhausted');
  assert.equal(terminal, false);
  probeFails = true;
  await assert.rejects(worker.runOnce(), /persistent S3 access outage/u);
  assert.equal(healthyFinalizations, 0);
  probeFails = false;
  assert.deepEqual(await worker.runOnce(), { processed: 0, expired: 0 });
  assert.equal(healthyFinalizations, 1);
});

test('T14 verifier recovery probe is aborted by a bounded deadline', async () => {
  let probeAborted = false;
  let heartbeat: string | null = null;
  const repository = {
    updateHeartbeat: async (_worker: string, result: string) => {
      heartbeat = result;
    },
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    probeAccess: async (signal?: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            probeAborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  } as unknown as VideoStorage;

  await assert.rejects(
    new VideoUploadWorkerService(
      repository,
      storage,
      { ...configuration(), verifyDeadlineSeconds: 0.05 },
      new MutableClock(now),
    ).runOnce(),
    /recovery probe timed out/u,
  );
  assert.equal(probeAborted, true);
  assert.equal(heartbeat, 'failed');
});

test('T14 slow download body renews its lease and fences once more before publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kinetra-t14-slow-body-'));
  try {
    const ffprobePath = await writeFakeFfprobe(directory, 'valid', validProbeBody);
    let claimed = false;
    let renewals = 0;
    let published = false;
    const repository = {
      claimVerification: async () => {
        if (claimed) return null;
        claimed = true;
        return { ...verifierUpload(), leaseToken: 'lease' };
      },
      renewVerificationLease: async (_id: string, token: string) => {
        assert.equal(token, 'lease');
        renewals += 1;
        return true;
      },
      publishVerified: async (input: { readonly leaseToken: string }) => {
        assert.equal(input.leaseToken, 'lease');
        published = true;
        return 'published' as const;
      },
      failVerification: async () => undefined,
      retryVerification: async () => false,
      quarantineVerification: async () => false,
      expireUploads: async () => 0,
      finalizeVerificationRun: async (_at: Date, failure: boolean) => !failure,
      updateHeartbeat: async () => undefined,
    } as unknown as VideoAdminRepository;
    const storage = verifierStorage(
      (async function* () {
        yield fakeMp4.subarray(0, 8);
        await new Promise((resolve) => setTimeout(resolve, 55));
        yield fakeMp4.subarray(8);
      })(),
    );
    const result = await new VideoUploadWorkerService(
      repository,
      storage,
      {
        ...configuration(),
        ffprobePath,
        verifyLeaseSeconds: 0.03,
        verifyDeadlineSeconds: 2,
      },
      new MutableClock(now),
    ).runOnce();
    assert.deepEqual(result, { processed: 1, expired: 0 });
    assert.equal(published, true);
    assert.ok(renewals >= 2, `expected periodic and final lease renewals, got ${renewals}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T14 verification deadline expiring during final renewal prevents publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kinetra-t14-final-fence-'));
  try {
    const ffprobePath = await writeFakeFfprobe(directory, 'valid', validProbeBody);
    let claimed = false;
    let renewalFinished = false;
    let published = false;
    let retried = false;
    const repository = {
      claimVerification: async () => {
        if (claimed) return null;
        claimed = true;
        return { ...verifierUpload(), leaseToken: 'deadline-lease' };
      },
      renewVerificationLease: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        renewalFinished = true;
        return true;
      },
      publishVerified: async () => {
        published = true;
        return 'published' as const;
      },
      failVerification: async () => undefined,
      retryVerification: async () => {
        retried = true;
        return true;
      },
      quarantineVerification: async () => false,
      expireUploads: async () => 0,
      finalizeVerificationRun: async (_at: Date, failure: boolean) => !failure,
      updateHeartbeat: async () => undefined,
    } as unknown as VideoAdminRepository;

    await assert.rejects(
      new VideoUploadWorkerService(
        repository,
        verifierStorage(),
        { ...configuration(), ffprobePath, verifyDeadlineSeconds: 0.2 },
        new MutableClock(now),
      ).runOnce(),
      /degraded/u,
    );
    assert.equal(renewalFinished, true);
    assert.equal(published, false);
    assert.equal(retried, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T14 lost verification lease aborts the body and stale token changes no state', async () => {
  let claimed = false;
  let retryCalls = 0;
  let terminal = false;
  let published = false;
  const repository = {
    claimVerification: async () => {
      if (claimed) return null;
      claimed = true;
      return { ...verifierUpload(), leaseToken: 'stale-lease' };
    },
    renewVerificationLease: async () => false,
    publishVerified: async () => {
      published = true;
      return 'published' as const;
    },
    failVerification: async () => {
      terminal = true;
    },
    retryVerification: async () => {
      retryCalls += 1;
      return false;
    },
    quarantineVerification: async () => false,
    expireUploads: async () => 0,
    finalizeVerificationRun: async () => false,
    updateHeartbeat: async () => undefined,
  } as unknown as VideoAdminRepository;
  const storage = {
    ...verifierStorage(),
    getObject: async (_key: string, _version: string | null | undefined, signal?: AbortSignal) => ({
      contentLength: fakeMp4.length,
      body: (async function* () {
        yield fakeMp4.subarray(0, 8);
        await new Promise<never>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      })(),
    }),
  } as VideoStorage;
  await assert.rejects(
    new VideoUploadWorkerService(
      repository,
      storage,
      { ...configuration(), verifyLeaseSeconds: 0.03 },
      new MutableClock(now),
    ).runOnce(),
    /lease/u,
  );
  assert.equal(retryCalls, 1);
  assert.equal(terminal, false);
  assert.equal(published, false);
});

test('T14 transient write and publish DB failures retain the object for retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kinetra-t14-runtime-failures-'));
  try {
    const ffprobePath = await writeFakeFfprobe(directory, 'valid', validProbeBody);
    for (const failure of ['write', 'publish'] as const) {
      let claimed = false;
      let retried = false;
      let terminal = false;
      const repository = {
        claimVerification: async () => {
          if (claimed) return null;
          claimed = true;
          return { ...verifierUpload(), leaseToken: 'lease' };
        },
        renewVerificationLease: async () => true,
        publishVerified: async () => {
          if (failure === 'publish') throw new Error('transient PostgreSQL failure');
          return 'published' as const;
        },
        failVerification: async () => {
          terminal = true;
        },
        retryVerification: async () => {
          retried = true;
          return true;
        },
        quarantineVerification: async () => false,
        expireUploads: async () => 0,
        finalizeVerificationRun: async (_at: Date, degraded: boolean) => !degraded,
        updateHeartbeat: async () => undefined,
      } as unknown as VideoAdminRepository;
      const storage = verifierStorage();
      const verifier =
        failure === 'write'
          ? new Mp4VideoVerifier(
              storage,
              ffprobePath,
              () =>
                new Writable({
                  write: (_chunk, _encoding, callback) => callback(new Error('temporary ENOSPC')),
                }),
            )
          : undefined;
      await assert.rejects(
        new VideoUploadWorkerService(
          repository,
          storage,
          { ...configuration(), ffprobePath },
          new MutableClock(now),
          verifier,
        ).runOnce(),
        /degraded/u,
      );
      assert.equal(retried, true);
      assert.equal(terminal, false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T14 retry exhaustion quarantines without deletion and a later empty run recovers health', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kinetra-t14-quarantine-'));
  try {
    const ffprobePath = await writeFakeFfprobe(directory, 'exit-one', 'process.exit(1);');
    let claimed = false;
    let quarantined = false;
    let terminal = false;
    let retries = 0;
    const repository = {
      claimVerification: async () => {
        if (claimed) return null;
        claimed = true;
        return { ...verifierUpload(8), leaseToken: 'lease' };
      },
      renewVerificationLease: async () => true,
      publishVerified: async () => 'published' as const,
      failVerification: async () => {
        terminal = true;
      },
      retryVerification: async () => {
        retries += 1;
        return true;
      },
      quarantineVerification: async () => {
        quarantined = true;
        return true;
      },
      expireUploads: async () => 0,
      finalizeVerificationRun: async (_at: Date, failure: boolean) => !failure,
      updateHeartbeat: async () => undefined,
    } as unknown as VideoAdminRepository;
    const worker = new VideoUploadWorkerService(
      repository,
      verifierStorage(),
      { ...configuration(), ffprobePath },
      new MutableClock(now),
    );
    await assert.rejects(worker.runOnce(), /degraded/u);
    assert.equal(quarantined, true);
    assert.equal(terminal, false);
    assert.equal(retries, 0);
    assert.deepEqual(await worker.runOnce(), { processed: 0, expired: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('T14 cleanup failure survives empty and mixed runs until a real retry recovers', async () => {
  type Phase = 'failed' | 'empty' | 'mixed' | 'recovered';
  let phase: Phase = 'failed';
  let unresolved = false;
  let heartbeat: 'failed' | 'succeeded' | null = null;
  const failedJobId = randomUUID();
  const failedObjectKey = `videos/workouts/week-01/day-1/${randomUUID()}.mp4`;
  const job = (id: string, objectKey: string) => ({
    id,
    objectKey,
    versionId: 'v1',
    multipartUploadId: null,
    attemptCount: 1,
  });
  const repository = {
    ...authorityRepository(),
    workersAreFresh: async () => !unresolved,
    reserveUpload: async () => {
      throw new Error('admission must stay closed');
    },
    claimDeletionJobs: async () =>
      phase === 'empty'
        ? []
        : phase === 'mixed'
          ? [
              job(randomUUID(), `videos/workouts/week-01/day-1/${randomUUID()}.mp4`),
              job(failedJobId, failedObjectKey),
            ]
          : [job(failedJobId, failedObjectKey)],
    isObjectReferenced: async () => false,
    completeDeletion: async (jobId: string) => {
      if (jobId === failedJobId) unresolved = false;
    },
    retryDeletion: async (jobId: string, errorCode: string) => {
      if (jobId === failedJobId) {
        assert.equal(errorCode, 'object_cleanup_failed');
        unresolved = true;
      }
    },
    finalizeCleanupRun: async (_at: Date, encounteredFailure: boolean) => {
      const healthy = !encounteredFailure && !unresolved;
      heartbeat = healthy ? 'succeeded' : 'failed';
      return healthy;
    },
    updateHeartbeat: async (_worker: string, result: string) => {
      if (result === 'failed' || result === 'succeeded') heartbeat = result;
    },
  } as unknown as VideoAdminRepository;
  const storage = {
    ...availableStorage(),
    deleteObject: async (objectKey: string) => {
      if (objectKey === failedObjectKey && phase !== 'recovered') throw new Error('S3 down');
    },
    listExactObjectVersions: async () => [],
  } as unknown as VideoStorage;
  const cleanup = new VideoMediaCleanupService(repository, storage, new MutableClock(now));

  await assert.rejects(cleanup.runOnce(), /degraded/u);
  assert.equal(heartbeat, 'failed');

  phase = 'empty';
  await assert.rejects(cleanup.runOnce(), /degraded/u);
  assert.equal(heartbeat, 'failed');
  await rejectsWith(
    () =>
      new VideoAdminService(
        repository,
        storage,
        configuration(),
        new MutableClock(now),
      ).createUpload(me, randomUUID(), {
        week_number: 1,
        day_of_week: 1,
        mime_type: 'video/mp4',
        size_bytes: fakeMp4.length,
      }),
    503,
    'VIDEO_STORAGE_UNAVAILABLE',
  );

  phase = 'mixed';
  await assert.rejects(cleanup.runOnce(), /degraded/u);
  assert.equal(heartbeat, 'failed');

  phase = 'recovered';
  assert.deepEqual(await cleanup.runOnce(), { completed: 1, retried: 0 });
  assert.equal(heartbeat, 'succeeded');
  assert.equal(unresolved, false);
});

test('T14 cleanup runtime does not depend on ffprobe availability', () => {
  const repository = {} as VideoAdminRepository;
  const storage = availableStorage() as VideoStorage;
  assert.deepEqual(createProductionVideoCleanupRuntime({ repository, storage }), {
    repository,
    storage,
  });
});
