import type { ObjectUrlSigner } from '../../src/base-lessons/storage.js';

export class FakeObjectUrlSigner implements ObjectUrlSigner {
  public readonly requestedKeys: string[] = [];

  public async getObjectUrl(key: string): Promise<string> {
    this.requestedKeys.push(key);
    return `https://storage.kinetra.test/${encodeURIComponent(key)}`;
  }
}
