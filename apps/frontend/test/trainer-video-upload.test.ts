import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TrainerVideoUploadDto } from '@kinetra/shared';

import {
  putVideoPart,
  uploadWorkoutVideo,
  type UploadWorkoutVideoDependencies,
} from '../src/features/trainer-videos/upload.js';

const upload = (
  status: TrainerVideoUploadDto['status'],
  id = '00000000-0000-4000-8000-000000000001',
): TrainerVideoUploadDto => ({
  id,
  video_id: '00000000-0000-4000-8000-000000000002',
  week_number: 1,
  day_of_week: 1,
  status,
  expected_size_bytes: 10,
  uploaded_bytes: 0,
  part_size_bytes: 5,
  part_count: 2,
  expires_at: '2026-08-24T18:00:00.000Z',
  failure_code: null,
  verified_media: null,
});

test('T14 upload keeps progress monotonic, retries parts and polls to server publication', async () => {
  const progress: number[] = [];
  const states: string[] = [];
  const checksummedSizes: number[] = [];
  const delays: number[] = [];
  const signedAttempts = new Map<number, number>();
  let firstPartFailures = 0;
  let now = 1_000;
  const dependencies: UploadWorkoutVideoDependencies = {
    createUpload: async (_input, key) => {
      assert.equal(key, '00000000-0000-4000-8000-000000000099');
      return { upload: upload('uploading') };
    },
    getUpload: async () => ({ upload: upload('published') }),
    getParts: async () => ({ parts: [] }),
    signParts: async (_uploadId, parts) => {
      const partNumber = parts[0]!.part_number;
      signedAttempts.set(partNumber, (signedAttempts.get(partNumber) ?? 0) + 1);
      return {
        parts: [
          {
            part_number: partNumber,
            upload_url: `https://s3.test/part-${partNumber}`,
            expires_at: '2026-08-24T12:15:00.000Z',
            required_headers: { 'x-amz-checksum-sha256': parts[0]!.checksum_sha256 },
          },
        ],
      };
    },
    completeUpload: async () => ({ upload: upload('verification_pending') }),
    putPart: async (url, blob, headers, _signal, onProgress) => {
      assert.deepEqual(Object.keys(headers), ['x-amz-checksum-sha256']);
      if (url.endsWith('part-1') && firstPartFailures === 0) {
        firstPartFailures += 1;
        onProgress(2);
        throw new Error('transient');
      }
      onProgress(3);
      onProgress(blob.size);
    },
    checksumPart: async (blob) => {
      checksummedSizes.push(blob.size);
      return `${'A'.repeat(43)}=`;
    },
    delay: async (milliseconds, signal) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      delays.push(milliseconds);
      now += milliseconds;
    },
    now: () => now,
    newIdempotencyKey: () => '00000000-0000-4000-8000-000000000099',
  };

  const result = await uploadWorkoutVideo({
    file: new File([Buffer.alloc(10)], 'workout.mp4', { type: 'video/mp4' }),
    weekNumber: 1,
    dayOfWeek: 1,
    signal: new AbortController().signal,
    onProgress: (bytes) => progress.push(bytes),
    onState: (current) => states.push(current.status),
    dependencies,
  });

  assert.equal(result.status, 'published');
  assert.deepEqual(
    checksummedSizes.sort((left, right) => left - right),
    [5, 5],
  );
  assert.equal(
    progress.every((value, index) => index === 0 || value >= progress[index - 1]!),
    true,
  );
  assert.equal(progress.at(-1), 10);
  assert.equal(signedAttempts.get(1), 2);
  assert.equal(signedAttempts.get(2), 1);
  assert.deepEqual(delays, [500, 2_000]);
  assert.deepEqual(states, ['uploading', 'verification_pending', 'published']);
});

test('T14 reload recovery skips S3 parts already confirmed by the server', async () => {
  const uploadedUrls: string[] = [];
  let createCalls = 0;
  const dependencies: UploadWorkoutVideoDependencies = {
    createUpload: async () => {
      createCalls += 1;
      return { upload: upload('uploading') };
    },
    getUpload: async () => ({ upload: upload('published') }),
    getParts: async () => ({
      parts: [{ part_number: 1, size_bytes: 5, checksum_sha256: `${'A'.repeat(43)}=` }],
    }),
    signParts: async (_uploadId, parts) => ({
      parts: [
        {
          part_number: parts[0]!.part_number,
          upload_url: `https://s3.test/part-${parts[0]!.part_number}`,
          expires_at: '2026-08-24T12:15:00.000Z',
          required_headers: { 'x-amz-checksum-sha256': parts[0]!.checksum_sha256 },
        },
      ],
    }),
    completeUpload: async () => ({ upload: upload('published') }),
    putPart: async (url, blob, _headers, _signal, onProgress) => {
      uploadedUrls.push(url);
      onProgress(blob.size);
    },
    checksumPart: async () => `${'A'.repeat(43)}=`,
    delay: async () => undefined,
    now: () => 1_000,
    newIdempotencyKey: () => '00000000-0000-4000-8000-000000000099',
  };

  await uploadWorkoutVideo({
    file: new File([Buffer.alloc(10)], 'workout.mp4', { type: 'video/mp4' }),
    weekNumber: 1,
    dayOfWeek: 1,
    existingUpload: upload('uploading'),
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onState: () => undefined,
    dependencies,
  });

  assert.equal(createCalls, 0);
  assert.deepEqual(uploadedUrls, ['https://s3.test/part-2']);
});

test('T14 resume rejects a same-size different file before signing or completing', async () => {
  let mutations = 0;
  const dependencies = {
    createUpload: async () => ({ upload: upload('uploading') }),
    getUpload: async () => ({ upload: upload('published') }),
    getParts: async () => ({
      parts: [{ part_number: 1, size_bytes: 5, checksum_sha256: 'original-checksum' }],
    }),
    signParts: async () => {
      mutations += 1;
      return { parts: [] };
    },
    completeUpload: async () => {
      mutations += 1;
      return { upload: upload('published') };
    },
    putPart: async () => undefined,
    checksumPart: async () => 'different-checksum',
    delay: async () => undefined,
    now: () => 1_000,
    newIdempotencyKey: () => crypto.randomUUID(),
  } as UploadWorkoutVideoDependencies;
  await assert.rejects(
    uploadWorkoutVideo({
      file: new File([Buffer.alloc(10)], 'workout.mp4', { type: 'video/mp4' }),
      weekNumber: 1,
      dayOfWeek: 1,
      existingUpload: upload('uploading'),
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onState: () => undefined,
      dependencies,
    }),
    /другой файл/u,
  );
  assert.equal(mutations, 0);
});

test('T14 an in-progress complete is retried for expired-lease recovery', async () => {
  let completeCalls = 0;
  const dependencies = {
    createUpload: async () => ({ upload: upload('uploading') }),
    getUpload: async () => ({ upload: upload('published') }),
    getParts: async () => ({ parts: [] }),
    signParts: async (_id, parts) => ({
      parts: [
        {
          part_number: parts[0]!.part_number,
          upload_url: `part-${parts[0]!.part_number}`,
          expires_at: '2026-08-24T12:15:00.000Z',
          required_headers: { 'x-amz-checksum-sha256': parts[0]!.checksum_sha256 },
        },
      ],
    }),
    completeUpload: async () => {
      completeCalls += 1;
      return { upload: upload(completeCalls === 1 ? 'completing' : 'published') };
    },
    putPart: async () => undefined,
    checksumPart: async () => `${'A'.repeat(43)}=`,
    delay: async () => undefined,
    now: () => 1_000,
    newIdempotencyKey: () => crypto.randomUUID(),
  } as UploadWorkoutVideoDependencies;
  const result = await uploadWorkoutVideo({
    file: new File([Buffer.alloc(10)], 'workout.mp4', { type: 'video/mp4' }),
    weekNumber: 1,
    dayOfWeek: 1,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    onState: () => undefined,
    dependencies,
  });
  assert.equal(result.status, 'published');
  assert.equal(completeCalls, 2);
});

test('T14 fatal part failure aborts sibling workers before completion', async () => {
  let completeCalls = 0;
  const dependencies = {
    createUpload: async () => ({ upload: upload('uploading') }),
    getUpload: async () => ({ upload: upload('published') }),
    getParts: async () => ({ parts: [] }),
    signParts: async (_id, parts) => ({
      parts: [
        {
          part_number: parts[0]!.part_number,
          upload_url: `part-${parts[0]!.part_number}`,
          expires_at: '2026-08-24T12:15:00.000Z',
          required_headers: { 'x-amz-checksum-sha256': parts[0]!.checksum_sha256 },
        },
      ],
    }),
    completeUpload: async () => {
      completeCalls += 1;
      return { upload: upload('published') };
    },
    putPart: async (url, _blob, _headers, signal) => {
      if (url === 'part-1') throw new Error('fatal');
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        }),
      );
    },
    checksumPart: async () => `${'A'.repeat(43)}=`,
    delay: async () => undefined,
    now: () => 1_000,
    newIdempotencyKey: () => crypto.randomUUID(),
  } as UploadWorkoutVideoDependencies;
  await assert.rejects(
    uploadWorkoutVideo({
      file: new File([Buffer.alloc(10)], 'workout.mp4', { type: 'video/mp4' }),
      weekNumber: 1,
      dayOfWeek: 1,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onState: () => undefined,
      dependencies,
    }),
    /fatal/u,
  );
  assert.equal(completeCalls, 0);
});

test('T14 S3 XHR sends only required checksum headers without credentials', async () => {
  const original = globalThis.XMLHttpRequest;
  const observed: {
    headers: Record<string, string>;
    withCredentials: boolean;
    method: string;
    url: string;
  } = { headers: {}, withCredentials: true, method: '', url: '' };

  class FakeXhr {
    public status = 200;
    public withCredentials = true;
    private readonly listeners = new Map<string, () => void>();
    public readonly upload = {
      addEventListener: (_name: string, listener: (event: ProgressEvent) => void): void => {
        listener({ loaded: 5 } as ProgressEvent);
      },
    };
    public open(method: string, url: string): void {
      observed.method = method;
      observed.url = url;
    }
    public setRequestHeader(name: string, value: string): void {
      observed.headers[name] = value;
    }
    public addEventListener(name: string, listener: () => void): void {
      this.listeners.set(name, listener);
    }
    public send(): void {
      observed.withCredentials = this.withCredentials;
      this.listeners.get('load')?.();
    }
    public abort(): void {
      this.listeners.get('abort')?.();
    }
  }

  Object.defineProperty(globalThis, 'XMLHttpRequest', {
    configurable: true,
    value: FakeXhr,
  });
  try {
    await putVideoPart(
      'https://s3.test/signed?X-Amz-Signature=temporary',
      new Blob([Buffer.alloc(5)]),
      { 'x-amz-checksum-sha256': `${'A'.repeat(43)}=` },
      new AbortController().signal,
      () => undefined,
    );
    assert.deepEqual(observed, {
      headers: { 'x-amz-checksum-sha256': `${'A'.repeat(43)}=` },
      withCredentials: false,
      method: 'PUT',
      url: 'https://s3.test/signed?X-Amz-Signature=temporary',
    });
    assert.equal('authorization' in observed.headers, false);
    assert.equal('cookie' in observed.headers, false);
    console.log('KINETRA_T14_UPLOAD_LIFECYCLE=PASS');
  } finally {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      configurable: true,
      value: original,
    });
  }
});

test('T14 S3 XHR honors an already-aborted signal without sending', async () => {
  const original = globalThis.XMLHttpRequest;
  let sent = false;
  class FakeXhr {
    public withCredentials = false;
    public readonly upload = { addEventListener: (): void => undefined };
    private readonly listeners = new Map<string, () => void>();
    public open(): void {}
    public setRequestHeader(): void {}
    public addEventListener(name: string, listener: () => void): void {
      this.listeners.set(name, listener);
    }
    public send(): void {
      sent = true;
    }
    public abort(): void {
      this.listeners.get('abort')?.();
    }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: FakeXhr });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      putVideoPart('https://s3.test/part', new Blob(), {}, controller.signal, () => undefined),
      (caught: unknown) => caught instanceof DOMException && caught.name === 'AbortError',
    );
    assert.equal(sent, false);
  } finally {
    Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: original });
  }
});
