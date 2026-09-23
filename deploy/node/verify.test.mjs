import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertDigest, assertRuntime, assertSignedChecksum } from './verify.mjs';

const manifest = JSON.parse(readFileSync(new URL('./source.json', import.meta.url), 'utf8'));
const status = `[GNUPG:] VALIDSIG ${manifest.signerFingerprint} 2026-07-29 1785333361 0 4 0 1 8 01 ${manifest.signerFingerprint}\n`;
const checksum = `${manifest.sourceSha256}  ${manifest.sourceFile}\n`;
const runtime = () => ({
  versions: { node: '22.23.2', modules: '127', openssl: '3.5.8' },
  node_shared_openssl: true,
});
const linkage =
  '\tlibssl.so.3 => /usr/lib/libssl.so.3 (0x123000)\n\tlibcrypto.so.3 => /usr/lib/libcrypto.so.3 (0x456000)\n';

test('the committed Node release key matches the verified fingerprint artifact hash', () => {
  assertDigest(new URL(manifest.keyFile, import.meta.url), manifest.keySha256);
});

test('signed checksums reject foreign, missing, duplicate, expired and revoked signatures', () => {
  assertSignedChecksum(status, checksum, manifest);
  for (const invalid of [
    '',
    status.repeat(2),
    status.replaceAll(manifest.signerFingerprint, 'A'.repeat(40)),
  ]) {
    assert.throws(() => assertSignedChecksum(invalid, checksum, manifest), /pinned release key/);
  }
  for (const failure of ['BADSIG', 'ERRSIG', 'EXPSIG', 'EXPKEYSIG', 'REVKEYSIG', 'NO_PUBKEY']) {
    assert.throws(
      () => assertSignedChecksum(`${status}[GNUPG:] ${failure}\n`, checksum, manifest),
      /pinned release key/,
    );
  }
});

test('an authenticated checksum file must match the precise pinned source once', () => {
  for (const invalid of [
    '',
    checksum.repeat(2),
    checksum.replace(manifest.sourceSha256, 'b'.repeat(64)),
    checksum.replace('22.23.2', '22.23.1'),
  ]) {
    assert.throws(() => assertSignedChecksum(status, invalid, manifest), /pinned source archive/);
  }
});

test('the replacement runtime rejects old embedded OpenSSL, static linking and changed Node ABI', () => {
  assertRuntime(runtime(), linkage, manifest);
  for (const [field, value] of [
    ['openssl', '3.5.7'],
    ['openssl', '3.6.0'],
    ['node', '24.18.1'],
    ['modules', '137'],
  ]) {
    const invalid = runtime();
    invalid.versions[field] = value;
    assert.throws(() => assertRuntime(invalid, linkage, manifest), /required ABI/);
  }
  assert.throws(
    () => assertRuntime({ ...runtime(), node_shared_openssl: false }, linkage, manifest),
    /required ABI/,
  );
});

test('runtime linkage rejects missing libraries and alternative paths', () => {
  for (const invalid of [
    '',
    linkage.replace('libssl.so.3 =>', 'not found =>'),
    linkage.replaceAll('/usr/lib/', '/unreviewed/lib/'),
    `${linkage}Error relocating node`,
  ]) {
    assert.throws(() => assertRuntime(runtime(), invalid, manifest), /required ABI/);
  }
});
