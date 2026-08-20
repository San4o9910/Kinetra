import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface ObjectUrlSigner {
  getObjectUrl(key: string): Promise<string | null>;
}

export interface S3ObjectUrlSignerConfig {
  readonly endpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly presignedUrlTtlSeconds: number;
}

export class UnavailableObjectUrlSigner implements ObjectUrlSigner {
  public async getObjectUrl(_key: string): Promise<null> {
    return null;
  }
}

export class S3ObjectUrlSigner implements ObjectUrlSigner {
  private readonly client: S3Client;

  public constructor(private readonly config: S3ObjectUrlSignerConfig) {
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

  public async getObjectUrl(key: string): Promise<string | null> {
    if (key.trim().length === 0) {
      return null;
    }

    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
      { expiresIn: this.config.presignedUrlTtlSeconds },
    );
  }
}
