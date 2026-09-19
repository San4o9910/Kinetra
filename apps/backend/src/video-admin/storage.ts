import { randomUUID } from 'node:crypto';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { S3Environment, VideoUploadsEnvironment } from '../config/env.js';

export interface StoredVideoPart {
  readonly partNumber: number;
  readonly size: number;
  readonly checksumSha256: string | null;
  readonly etag: string;
}

export interface StoredVideoHead {
  readonly size: number;
  readonly uploadId: string | null;
  readonly etag: string | null;
  readonly versionId: string | null;
  readonly encryption: string | null;
  readonly kmsKeyId: string | null;
}

export type VideoEncryptionExpectation = Pick<
  VideoUploadsEnvironment,
  'serverSideEncryption' | 'kmsKeyId'
>;

export const hasExpectedVideoEncryption = (
  head: Pick<StoredVideoHead, 'encryption' | 'kmsKeyId'>,
  expected: Readonly<VideoEncryptionExpectation>,
): boolean =>
  head.encryption === expected.serverSideEncryption &&
  (expected.serverSideEncryption === 'aws:kms'
    ? expected.kmsKeyId !== null && head.kmsKeyId === expected.kmsKeyId
    : head.kmsKeyId === null);

export interface VideoObjectStream {
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentLength: number;
}

export interface VideoStorage {
  readonly available: boolean;
  probeAccess(signal?: AbortSignal): Promise<void>;
  createMultipart(input: { uploadId: string; videoId: string; objectKey: string }): Promise<string>;
  signPart(input: {
    objectKey: string;
    multipartUploadId: string;
    partNumber: number;
    size: number;
    checksumSha256: string;
    expiresInSeconds: number;
  }): Promise<string>;
  listParts(
    objectKey: string,
    multipartUploadId: string,
    signal?: AbortSignal,
  ): Promise<readonly StoredVideoPart[]>;
  completeMultipart(
    objectKey: string,
    multipartUploadId: string,
    parts: readonly StoredVideoPart[],
    signal?: AbortSignal,
  ): Promise<{ etag: string | null; versionId: string | null }>;
  abortMultipart(objectKey: string, multipartUploadId: string, signal?: AbortSignal): Promise<void>;
  headObject(
    objectKey: string,
    versionId?: string | null,
    signal?: AbortSignal,
  ): Promise<StoredVideoHead | null>;
  getObject(
    objectKey: string,
    versionId?: string | null,
    signal?: AbortSignal,
  ): Promise<VideoObjectStream>;
  signGet(objectKey: string, expiresInSeconds: number, versionId?: string | null): Promise<string>;
  listExactObjectVersions(objectKey: string, signal?: AbortSignal): Promise<readonly string[]>;
  deleteObject(objectKey: string, versionId: string | null, signal?: AbortSignal): Promise<void>;
}

const assertVideoKey = (key: string): void => {
  if (!/^videos\/workouts\/week-[0-9]{2}\/day-[1-7]\/[0-9a-f-]{36}\.mp4$/u.test(key)) {
    throw new Error('Video object key is outside the allowed prefix.');
  }
};

const assertCleanupVideoKey = (key: string): void => {
  if (
    !/^videos\/workouts\/week-[0-9]{2}\/day-[1-7]\/(?:[0-9a-f-]{36}\.mp4)$/u.test(key) &&
    !/^videos\/workouts\/week-[0-9]{2}\/day-[1-7]\.mp4$/u.test(key)
  )
    throw new Error('Video cleanup key is outside the allowed paths.');
};

const isNotFound = (error: unknown): boolean => {
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  return ['NoSuchKey', 'NotFound', 'NoSuchUpload'].includes(name);
};

export class UnavailableVideoStorage implements VideoStorage {
  public readonly available = false;
  private fail(): never {
    throw new Error('Video storage is unavailable.');
  }
  public async createMultipart(): Promise<string> {
    return this.fail();
  }
  public async probeAccess(): Promise<void> {
    this.fail();
  }
  public async signPart(): Promise<string> {
    return this.fail();
  }
  public async listParts(): Promise<readonly StoredVideoPart[]> {
    return this.fail();
  }
  public async completeMultipart(): Promise<{ etag: string | null; versionId: string | null }> {
    return this.fail();
  }
  public async abortMultipart(): Promise<void> {
    this.fail();
  }
  public async headObject(): Promise<StoredVideoHead | null> {
    return this.fail();
  }
  public async getObject(): Promise<VideoObjectStream> {
    return this.fail();
  }
  public async signGet(): Promise<string> {
    return this.fail();
  }
  public async listExactObjectVersions(): Promise<readonly string[]> {
    return this.fail();
  }
  public async deleteObject(): Promise<void> {
    this.fail();
  }
}

export class S3VideoStorage implements VideoStorage {
  public readonly available = true;
  private readonly client: S3Client;

  public constructor(
    private readonly s3: Readonly<Omit<S3Environment, 'presignedUrlTtlSeconds'>>,
    private readonly video: Readonly<VideoEncryptionExpectation> = {
      serverSideEncryption: 'AES256',
      kmsKeyId: null,
    },
  ) {
    this.client = new S3Client({
      region: s3.region,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      forcePathStyle: s3.forcePathStyle,
      ...(s3.endpoint === null ? {} : { endpoint: s3.endpoint }),
    });
  }

  public async probeAccess(signal?: AbortSignal): Promise<void> {
    const options = signal === undefined ? undefined : { abortSignal: signal };
    await this.client.send(
      new ListObjectVersionsCommand({
        Bucket: this.s3.bucket,
        Prefix: 'videos/workouts/',
        MaxKeys: 1,
      }),
      options,
    );
    const missingKey = `videos/workouts/week-01/day-1/${randomUUID()}.mp4`;
    for (const command of [
      new HeadObjectCommand({ Bucket: this.s3.bucket, Key: missingKey }),
      new GetObjectCommand({ Bucket: this.s3.bucket, Key: missingKey }),
    ]) {
      try {
        await this.client.send(command, options);
        throw new Error('The reserved video access-probe object unexpectedly exists.');
      } catch (caught) {
        if (!isNotFound(caught)) throw caught;
      }
    }
  }

  public async createMultipart(input: {
    uploadId: string;
    videoId: string;
    objectKey: string;
  }): Promise<string> {
    assertVideoKey(input.objectKey);
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.s3.bucket,
        Key: input.objectKey,
        ContentType: 'video/mp4',
        ContentDisposition: 'inline',
        CacheControl: 'private, no-store',
        ChecksumAlgorithm: 'SHA256',
        ServerSideEncryption: this.video.serverSideEncryption,
        ...(this.video.kmsKeyId === null ? {} : { SSEKMSKeyId: this.video.kmsKeyId }),
        Metadata: { 'kinetra-upload-id': input.uploadId, 'kinetra-video-id': input.videoId },
      }),
    );
    if (result.UploadId === undefined || result.UploadId.length === 0) {
      throw new Error('S3 did not return a multipart upload ID.');
    }
    return result.UploadId;
  }

  public async signPart(input: {
    objectKey: string;
    multipartUploadId: string;
    partNumber: number;
    size: number;
    checksumSha256: string;
    expiresInSeconds: number;
  }): Promise<string> {
    assertVideoKey(input.objectKey);
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.s3.bucket,
        Key: input.objectKey,
        UploadId: input.multipartUploadId,
        PartNumber: input.partNumber,
        ContentLength: input.size,
        ChecksumSHA256: input.checksumSha256,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  public async listParts(
    objectKey: string,
    multipartUploadId: string,
    signal?: AbortSignal,
  ): Promise<readonly StoredVideoPart[]> {
    assertVideoKey(objectKey);
    const parts: StoredVideoPart[] = [];
    let marker: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.client.send(
        new ListPartsCommand({
          Bucket: this.s3.bucket,
          Key: objectKey,
          UploadId: multipartUploadId,
          ...(marker === undefined ? {} : { PartNumberMarker: marker }),
        }),
        signal === undefined ? undefined : { abortSignal: signal },
      );
      for (const part of result.Parts ?? []) {
        if (part.PartNumber === undefined || part.Size === undefined || part.ETag === undefined)
          continue;
        parts.push({
          partNumber: part.PartNumber,
          size: part.Size,
          checksumSha256: part.ChecksumSHA256 ?? null,
          etag: part.ETag,
        });
      }
      if (!result.IsTruncated)
        return parts.sort((left, right) => left.partNumber - right.partNumber);
      if (result.NextPartNumberMarker === undefined)
        throw new Error('S3 part listing did not provide a continuation.');
      marker = String(result.NextPartNumberMarker);
    }
    throw new Error('S3 multipart upload has too many part pages.');
  }

  public async completeMultipart(
    objectKey: string,
    multipartUploadId: string,
    parts: readonly StoredVideoPart[],
    signal?: AbortSignal,
  ): Promise<{ etag: string | null; versionId: string | null }> {
    assertVideoKey(objectKey);
    const completedParts: CompletedPart[] = parts.map((part) => ({
      ETag: part.etag,
      PartNumber: part.partNumber,
      ...(part.checksumSha256 === null ? {} : { ChecksumSHA256: part.checksumSha256 }),
    }));
    const result = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.s3.bucket,
        Key: objectKey,
        UploadId: multipartUploadId,
        MultipartUpload: { Parts: completedParts },
      }),
      signal === undefined ? undefined : { abortSignal: signal },
    );
    return { etag: result.ETag ?? null, versionId: result.VersionId ?? null };
  }

  public async abortMultipart(
    objectKey: string,
    multipartUploadId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertVideoKey(objectKey);
    const options = signal === undefined ? undefined : { abortSignal: signal };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: this.s3.bucket,
            Key: objectKey,
            UploadId: multipartUploadId,
          }),
          options,
        );
        await this.client.send(
          new ListPartsCommand({
            Bucket: this.s3.bucket,
            Key: objectKey,
            UploadId: multipartUploadId,
            MaxParts: 1,
          }),
          options,
        );
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
    }
    throw new Error('S3 multipart abort could not be confirmed.');
  }

  public async headObject(
    objectKey: string,
    versionId: string | null = null,
    signal?: AbortSignal,
  ): Promise<StoredVideoHead | null> {
    assertCleanupVideoKey(objectKey);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.s3.bucket,
          Key: objectKey,
          ...(versionId === null ? {} : { VersionId: versionId }),
        }),
        signal === undefined ? undefined : { abortSignal: signal },
      );
      return {
        size: result.ContentLength ?? 0,
        uploadId: result.Metadata?.['kinetra-upload-id'] ?? null,
        etag: result.ETag ?? null,
        versionId: result.VersionId ?? null,
        encryption: result.ServerSideEncryption ?? null,
        kmsKeyId: result.SSEKMSKeyId ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  public async getObject(
    objectKey: string,
    versionId: string | null = null,
    signal?: AbortSignal,
  ): Promise<VideoObjectStream> {
    assertVideoKey(objectKey);
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.s3.bucket,
        Key: objectKey,
        ...(versionId === null ? {} : { VersionId: versionId }),
      }),
      signal === undefined ? undefined : { abortSignal: signal },
    );
    const body = result.Body as unknown as Partial<AsyncIterable<Uint8Array>> | undefined;
    if (body === undefined || typeof body[Symbol.asyncIterator] !== 'function')
      throw new Error('S3 object body is not streamable.');
    return { body: body as AsyncIterable<Uint8Array>, contentLength: result.ContentLength ?? 0 };
  }

  public async signGet(
    objectKey: string,
    expiresInSeconds: number,
    versionId: string | null = null,
  ): Promise<string> {
    assertCleanupVideoKey(objectKey);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.s3.bucket,
        Key: objectKey,
        ...(versionId === null ? {} : { VersionId: versionId }),
        ResponseCacheControl: 'private, no-store',
        ResponseContentType: 'video/mp4',
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  public async listExactObjectVersions(
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    assertCleanupVideoKey(objectKey);
    const options = signal === undefined ? undefined : { abortSignal: signal };
    const versions = new Set<string>();
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.s3.bucket,
          Prefix: objectKey,
          MaxKeys: 1000,
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
        }),
        options,
      );
      for (const entry of [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])]) {
        if (entry.Key === objectKey && entry.VersionId !== undefined) versions.add(entry.VersionId);
      }
      if (!result.IsTruncated) return [...versions];
      if (result.NextKeyMarker === undefined)
        throw new Error('S3 version listing did not provide a continuation.');
      keyMarker = result.NextKeyMarker;
      versionIdMarker = result.NextVersionIdMarker;
    }
    throw new Error('S3 object has too many version pages.');
  }

  public async deleteObject(
    objectKey: string,
    versionId: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    assertCleanupVideoKey(objectKey);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.s3.bucket,
        Key: objectKey,
        ...(versionId === null ? {} : { VersionId: versionId }),
      }),
      signal === undefined ? undefined : { abortSignal: signal },
    );
  }
}
