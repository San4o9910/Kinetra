import {
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { ChatMediaStore } from './media.js';

export interface S3ChatMediaStoreConfig {
  readonly endpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

export class S3ChatMediaStore implements ChatMediaStore {
  public readonly available = true;
  private readonly client: S3Client;

  public constructor(private readonly config: S3ChatMediaStoreConfig) {
    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
      ...(config.endpoint === null ? {} : { endpoint: config.endpoint }),
    });
  }

  public async putObject(key: string, body: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        CacheControl: 'private, no-store',
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  public async createSignedGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseCacheControl: 'private, no-store',
        ResponseContentType: 'image/webp',
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  public async deleteObject(key: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let versionedEntriesFound = false;

    for (let page = 0; page < 100; page += 1) {
      const listed = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.config.bucket,
          Prefix: key,
          MaxKeys: 1_000,
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
        }),
      );
      const entries = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
        .filter((entry) => entry.Key === key && entry.VersionId !== undefined)
        .map((entry) => ({ Key: key, VersionId: entry.VersionId! }));

      if (entries.length > 0) {
        versionedEntriesFound = true;
        const deleted = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.config.bucket,
            Delete: { Objects: entries, Quiet: true },
          }),
        );

        if ((deleted.Errors?.length ?? 0) > 0) {
          throw new Error('Private chat media version deletion was incomplete.');
        }
      }

      if (listed.IsTruncated !== true) {
        if (!versionedEntriesFound) {
          await this.client.send(
            new DeleteObjectCommand({
              Bucket: this.config.bucket,
              Key: key,
            }),
          );
        }

        return;
      }

      if (listed.NextKeyMarker === undefined) {
        throw new Error('Private chat media version listing did not provide a continuation.');
      }

      keyMarker = listed.NextKeyMarker;
      versionIdMarker = listed.NextVersionIdMarker;
    }

    throw new Error('Private chat media has more than 100 version pages; cleanup will retry.');
  }
}
