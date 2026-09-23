import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertDigest, assertSignature, sha256, sourceBom } from './inventory.mjs';

const manifest = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
const signed = (fingerprint) =>
  `[GNUPG:] VALIDSIG ${fingerprint} 2026-09-04 1788483822 0 4 0 1 10 00 ${fingerprint}\n`;
const records = () =>
  manifest.components.map((component) => ({
    ...component,
    binaryHashes: Object.fromEntries(component.binaries.map((path) => [path, 'a'.repeat(64)])),
  }));

test('the committed release keys match the reviewed manifest hashes', () => {
  for (const component of manifest.components) {
    assertDigest(new URL(component.keyFile, import.meta.url), component.keySha256);
  }
});

test('an archive change or invalid digest fails verification', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kinetra-source-digest-'));
  try {
    const archive = join(directory, 'source.tar.xz');
    writeFileSync(archive, 'verified archive fixture');
    const digest = sha256(archive);
    assertDigest(archive, digest);
    writeFileSync(archive, 'modified archive fixture');
    assert.throws(() => assertDigest(archive, digest), /SHA256 mismatch/);
    assert.throws(() => assertDigest(archive, ''), /SHA256 mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source signatures require one valid signature from the pinned primary key', () => {
  const expected = manifest.components[0].signerFingerprint;
  const foreign = manifest.components[1].signerFingerprint;
  assertSignature(signed(expected), expected);
  const subkeyStatus = signed(expected).replace(`VALIDSIG ${expected}`, `VALIDSIG ${foreign}`);
  assertSignature(subkeyStatus, expected);
  for (const status of ['', signed(foreign), signed(expected).repeat(2)]) {
    assert.throws(() => assertSignature(status, expected), /pinned primary signing key/);
  }
  for (const failure of ['BADSIG', 'ERRSIG', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG', 'NO_PUBKEY']) {
    assert.throws(
      () => assertSignature(`${signed(expected)}[GNUPG:] ${failure} fixture\n`, expected),
      /invalid, expired or revoked/,
    );
  }
});

test('source SBOM includes both upstream identities and all measured executable hashes', () => {
  const components = records();
  const bom = sourceBom(components);
  assert.equal(bom.components.length, 2);
  for (const component of components) {
    const entry = bom.components.find((value) => value.name === component.name);
    assert.equal(entry.cpe, component.cpe);
    assert.equal(entry.version, component.version);
    assert.deepEqual(
      entry.evidence.occurrences.map((item) => item.location),
      component.binaries.map((path) => `/${path}`),
    );
    for (const path of component.binaries) {
      assert.equal(
        entry.properties.find((property) => property.name === `kinetra:binary:sha256:/${path}`)
          .value,
        component.binaryHashes[path],
      );
    }
    assert.equal(
      entry.hashes,
      undefined,
      'source archive digest must not represent installed binary',
    );
    assert.equal(entry.externalReferences[1].hashes[0].content, component.sourceSha256);
  }
});

test('missing applications or executable hashes cannot produce a complete-looking source SBOM', () => {
  assert.throws(() => sourceBom(records().slice(0, 1)), /both media applications/);
  assert.throws(() => sourceBom([records()[0], records()[0]]), /both media applications/);
  const components = records();
  delete components[1].binaryHashes['usr/bin/convert'];
  assert.throws(() => sourceBom(components), /Incomplete upstream or executable identity/);
});
