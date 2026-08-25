import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { S3Environment, VideoUploadsEnvironment } from '../src/config/env.js';
import type { VideoAdminRepository } from '../src/video-admin/repository.js';
import { S3VideoStorage } from '../src/video-admin/storage.js';
import { VideoMediaCleanupService } from '../src/video-admin/worker-service.js';
import { MutableClock } from './support/test-clock.js';

const endpoint = process.env.KINETRA_S3_TEST_ENDPOINT;
const s3Required = process.env.KINETRA_REQUIRE_S3_TEST === 'true';

if (s3Required && endpoint === undefined) {
  throw new Error('KINETRA_S3_TEST_ENDPOINT is required because KINETRA_REQUIRE_S3_TEST=true.');
}

const accessKeyId = process.env.KINETRA_S3_TEST_ACCESS_KEY ?? 'kinetra-test-access';
const secretAccessKey =
  process.env.KINETRA_S3_TEST_SECRET_KEY ?? 'kinetra-test-secret-not-for-production';
const region = 'us-east-1';

const checksum = (body: Uint8Array): string => createHash('sha256').update(body).digest('base64');

const put = async (url: string, body: Uint8Array, sha256: string): Promise<Response> =>
  fetch(url, {
    method: 'PUT',
    headers: {
      'content-length': String(body.byteLength),
      'x-amz-checksum-sha256': sha256,
    },
    body,
  });

const cleanLegacyThroughWorker = async (
  storage: S3VideoStorage,
  objectKey: string,
): Promise<void> => {
  let claimed = false;
  let completed = false;
  const repository = {
    claimDeletionJobs: async () => {
      if (claimed) return [];
      claimed = true;
      return [
        {
          id: randomUUID(),
          objectKey,
          versionId: null,
          multipartUploadId: null,
          attemptCount: 1,
        },
      ];
    },
    isObjectReferenced: async () => false,
    completeDeletion: async () => {
      completed = true;
    },
    retryDeletion: async () => {
      throw new Error('Legacy cleanup unexpectedly entered retry.');
    },
    finalizeCleanupRun: async (_now: Date, encounteredFailure: boolean) => !encounteredFailure,
    updateHeartbeat: async () => undefined,
  } as unknown as VideoAdminRepository;
  assert.deepEqual(
    await new VideoMediaCleanupService(
      repository,
      storage,
      new MutableClock(new Date('2026-08-24T12:00:00.000Z')),
    ).runOnce(),
    { completed: 1, retried: 0 },
  );
  assert.equal(completed, true);
  assert.equal(await storage.headObject(objectKey), null);
  assert.deepEqual(await storage.listExactObjectVersions(objectKey), []);
};

test(
  'T14 presigned multipart performs real checksum-bound HTTP PUTs against private S3 storage',
  {
    skip: endpoint === undefined ? 'KINETRA_S3_TEST_ENDPOINT is not configured.' : false,
    timeout: 30_000,
  },
  async () => {
    if (endpoint === undefined) {
      throw new Error('KINETRA_S3_TEST_ENDPOINT is required for S3 integration.');
    }
    const bucket = `kinetra-t14-versioned-${randomUUID()}`;
    const unversionedBucket = `kinetra-t14-unversioned-${randomUUID()}`;
    const s3: Readonly<S3Environment> = {
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: true,
      presignedUrlTtlSeconds: 900,
    };
    const video: Readonly<VideoUploadsEnvironment> = {
      enabled: true,
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
    };
    const client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
    const storage = new S3VideoStorage(s3, video);
    const unversionedStorage = new S3VideoStorage({ ...s3, bucket: unversionedBucket }, video);
    const first = Buffer.alloc(5_242_880, 0x31);
    const second = Buffer.alloc(1_048_576, 0x32);
    const uploadId = randomUUID();
    const videoId = randomUUID();
    const key = `videos/workouts/week-01/day-1/${uploadId}.mp4`;
    let multipartId: string | null = null;
    let expiredMultipartId: string | null = null;
    let expiredKey: string | null = null;
    let completed = false;
    const versionedLegacyKey = 'videos/workouts/week-01/day-1.mp4';
    const unversionedLegacyKey = 'videos/workouts/week-01/day-2.mp4';
    const versionedSiblingKey = `videos/workouts/week-01/day-1/${randomUUID()}.mp4`;
    const unversionedSiblingKey = `videos/workouts/week-01/day-2/${randomUUID()}.mp4`;
    const absentVersionedKey = `videos/workouts/week-01/day-3/${randomUUID()}.mp4`;

    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      await client.send(new CreateBucketCommand({ Bucket: unversionedBucket }));
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );
      await storage.probeAccess();
      await unversionedStorage.probeAccess();
      multipartId = await storage.createMultipart({ uploadId, videoId, objectKey: key });

      const firstUrl = await storage.signPart({
        objectKey: key,
        multipartUploadId: multipartId,
        partNumber: 1,
        size: first.byteLength,
        checksumSha256: checksum(first),
        expiresInSeconds: 60,
      });
      const wrong = await put(firstUrl, Buffer.alloc(first.byteLength, 0x39), checksum(first));
      assert.equal(wrong.ok, false);

      const acceptedFirst = await put(firstUrl, first, checksum(first));
      assert.equal(acceptedFirst.ok, true, await acceptedFirst.text());
      const secondUrl = await storage.signPart({
        objectKey: key,
        multipartUploadId: multipartId,
        partNumber: 2,
        size: second.byteLength,
        checksumSha256: checksum(second),
        expiresInSeconds: 60,
      });
      const acceptedSecond = await put(secondUrl, second, checksum(second));
      assert.equal(acceptedSecond.ok, true, await acceptedSecond.text());

      const parts = await storage.listParts(key, multipartId);
      assert.deepEqual(
        parts.map(({ partNumber, size, checksumSha256 }) => ({
          partNumber,
          size,
          checksumSha256,
        })),
        [
          { partNumber: 1, size: first.byteLength, checksumSha256: checksum(first) },
          { partNumber: 2, size: second.byteLength, checksumSha256: checksum(second) },
        ],
      );
      const completedObject = await storage.completeMultipart(key, multipartId, parts);
      completed = true;
      multipartId = null;
      const head = await storage.headObject(key, completedObject.versionId);
      assert.equal(head?.size, first.byteLength + second.byteLength);
      assert.equal(head?.uploadId, uploadId);
      assert.equal(head?.encryption, 'AES256');
      assert.equal(head?.kmsKeyId, null);
      assert.equal(
        (await storage.listExactObjectVersions(key)).every((versionId) => versionId.length > 0),
        true,
      );
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from('newer version') }),
      );
      assert.notEqual((await storage.headObject(key))?.size, head?.size);
      assert.equal(
        (await storage.headObject(key, completedObject.versionId))?.size,
        first.byteLength + second.byteLength,
      );
      const versionedPreview = await fetch(
        await storage.signGet(key, 60, completedObject.versionId),
      );
      assert.equal(
        (await versionedPreview.arrayBuffer()).byteLength,
        first.byteLength + second.byteLength,
      );

      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: versionedLegacyKey, Body: 'legacy-v1' }),
      );
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: versionedLegacyKey, Body: 'legacy-v2' }),
      );
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: versionedSiblingKey, Body: 'keep-versioned' }),
      );
      assert.equal((await storage.listExactObjectVersions(versionedLegacyKey)).length, 2);
      await cleanLegacyThroughWorker(storage, versionedLegacyKey);
      assert.notEqual(await storage.headObject(versionedSiblingKey), null);
      await cleanLegacyThroughWorker(storage, absentVersionedKey);
      assert.deepEqual(await storage.listExactObjectVersions(absentVersionedKey), []);

      await client.send(
        new PutObjectCommand({
          Bucket: unversionedBucket,
          Key: unversionedLegacyKey,
          Body: 'legacy-unversioned',
        }),
      );
      await client.send(
        new PutObjectCommand({
          Bucket: unversionedBucket,
          Key: unversionedSiblingKey,
          Body: 'keep-unversioned',
        }),
      );
      await cleanLegacyThroughWorker(unversionedStorage, unversionedLegacyKey);
      assert.notEqual(await unversionedStorage.headObject(unversionedSiblingKey), null);

      const expiredUploadId = randomUUID();
      const expiredObjectKey = `videos/workouts/week-01/day-2/${expiredUploadId}.mp4`;
      expiredKey = expiredObjectKey;
      expiredMultipartId = await storage.createMultipart({
        uploadId: expiredUploadId,
        videoId,
        objectKey: expiredObjectKey,
      });
      const expiringUrl = await storage.signPart({
        objectKey: expiredObjectKey,
        multipartUploadId: expiredMultipartId,
        partNumber: 1,
        size: first.byteLength,
        checksumSha256: checksum(first),
        expiresInSeconds: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      assert.equal((await put(expiringUrl, first, checksum(first))).ok, false);
      await storage.abortMultipart(expiredObjectKey, expiredMultipartId);
      expiredMultipartId = null;
      await assert.rejects(() => storage.listParts(expiredObjectKey, 'missing-upload'));

      for (const versionId of await storage.listExactObjectVersions(key))
        await storage.deleteObject(key, versionId);
      completed = false;
      assert.equal(await storage.headObject(key), null);
      for (const versionId of await storage.listExactObjectVersions(versionedSiblingKey))
        await storage.deleteObject(versionedSiblingKey, versionId);
      await unversionedStorage.deleteObject(unversionedSiblingKey, null);
      console.log('KINETRA_T14_S3_MULTIPART=PASS');
      console.log('KINETRA_T14_S3_LEGACY_CLEANUP=PASS');
    } finally {
      if (multipartId !== null)
        await storage.abortMultipart(key, multipartId).catch(() => undefined);
      if (expiredMultipartId !== null && expiredKey !== null) {
        await storage.abortMultipart(expiredKey, expiredMultipartId).catch(() => undefined);
      }
      if (completed) {
        for (const versionId of await storage.listExactObjectVersions(key).catch(() => []))
          await storage.deleteObject(key, versionId).catch(() => undefined);
      }
      for (const targetKey of [versionedLegacyKey, versionedSiblingKey])
        for (const versionId of await storage.listExactObjectVersions(targetKey).catch(() => []))
          await storage.deleteObject(targetKey, versionId).catch(() => undefined);
      for (const targetKey of [unversionedLegacyKey, unversionedSiblingKey])
        await unversionedStorage.deleteObject(targetKey, null).catch(() => undefined);
      await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
      await client
        .send(new DeleteBucketCommand({ Bucket: unversionedBucket }))
        .catch(() => undefined);
      client.destroy();
    }
  },
);
