import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  draftKey,
  readDraft,
  writeDraft,
  clearTrainingDrafts,
} from '../src/features/training/drafts';
test('training drafts survive remounts and account cleanup preserves only the other account', () => {
  const values: Record<string, string> = {};
  const storage = new Proxy(values, {
    get(target, key) {
      if (key === 'getItem') return (k: string) => target[k] ?? null;
      if (key === 'setItem')
        return (k: string, v: string) => {
          target[k] = v;
        };
      if (key === 'removeItem')
        return (k: string) => {
          delete target[k];
        };
      return target[String(key)];
    },
  });
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    const a = draftKey('student-a', 'workout', 'one'),
      b = draftKey('student-b', 'workout', 'one');
    assert.equal(writeDraft(a, { records: [{ set: 1 }], revision: 3, pending: true }), true);
    writeDraft(b, { pending: true });
    assert.deepEqual(readDraft(a), { records: [{ set: 1 }], revision: 3, pending: true });
    clearTrainingDrafts('student-a');
    assert.equal(readDraft(a), null);
    assert.deepEqual(readDraft(b), { pending: true });
    values[b] = 'corrupt';
    assert.equal(readDraft(b), null);
  } finally {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
  assert.equal(writeDraft('unavailable', {}), false);
  assert.equal(readDraft('unavailable'), null);
});
