import type { Clock } from '../../src/auth/service.js';
import type {
  ChatImageProcessor,
  ChatMediaStore,
  NormalizedChatPhoto,
} from '../../src/chat/media.js';

export class FixedChatClock implements Clock {
  public constructor(private value: Date) {}

  public now(): Date {
    return new Date(this.value.getTime());
  }

  public set(value: Date): void {
    this.value = new Date(value.getTime());
  }
}

export class FakeChatImageProcessor implements ChatImageProcessor {
  public failure: Error | null = null;

  public async normalize(_input: Buffer): Promise<NormalizedChatPhoto> {
    if (this.failure !== null) {
      throw this.failure;
    }

    return {
      bytes: Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBP', 'binary'),
      mimeType: 'image/webp',
      width: 320,
      height: 240,
    };
  }
}

export class FakeChatMediaStore implements ChatMediaStore {
  public readonly objects = new Map<string, Buffer>();
  public available = true;
  public failPut = false;
  public failDelete = false;
  public failSignedGet = false;

  public async putObject(key: string, body: Buffer): Promise<void> {
    if (!this.available || this.failPut) {
      throw new Error('Fake put failure.');
    }

    this.objects.set(key, Buffer.from(body));
  }

  public async createSignedGet(key: string, expiresInSeconds: number): Promise<string> {
    if (!this.available || this.failSignedGet || !this.objects.has(key)) {
      throw new Error('Fake signed GET failure.');
    }

    return `https://private.invalid/photo?ttl=${expiresInSeconds}`;
  }

  public async deleteObject(key: string): Promise<void> {
    if (!this.available || this.failDelete) {
      throw new Error('Fake delete failure.');
    }

    this.objects.delete(key);
  }
}
