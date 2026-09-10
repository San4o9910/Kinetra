import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function assertDigest(file, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(file) !== expected) {
    throw new Error(`Node source SHA256 mismatch: ${file}`);
  }
}

export function assertSignedChecksum(status, checksums, manifest) {
  const valid = status.split('\n').filter((line) => line.startsWith('[GNUPG:] VALIDSIG '));
  if (
    !/^[A-F0-9]{40}$/.test(manifest.signerFingerprint) ||
    valid.length !== 1 ||
    valid[0].trim().split(/\s+/).at(-1) !== manifest.signerFingerprint ||
    /\[GNUPG:\] (?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY)\b/.test(status)
  ) {
    throw new Error('Node checksums lack one valid signature from the pinned release key');
  }
  const entries = checksums
    .split('\n')
    .map((line) => /^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line))
    .filter((entry) => entry?.[2] === manifest.sourceFile);
  if (entries.length !== 1 || entries[0][1] !== manifest.sourceSha256) {
    throw new Error(
      'Signed Node checksum does not identify the pinned source archive exactly once',
    );
  }
}

export function assertRuntime(runtime, linkage, manifest) {
  const openssl = /^(\d+)\.(\d+)\.(\d+)(?:[+.-].*)?$/.exec(runtime.versions?.openssl ?? '');
  if (
    runtime.versions?.node !== manifest.version ||
    runtime.versions?.modules !== manifest.moduleAbi ||
    runtime.node_shared_openssl !== true ||
    !openssl ||
    Number(openssl[1]) !== 3 ||
    Number(openssl[2]) !== 5 ||
    Number(openssl[3]) < 8 ||
    !/^\s*libssl\.so\.3\s+=>\s+\/usr\/lib\/libssl\.so\.3\s+\(/m.test(linkage) ||
    !/^\s*libcrypto\.so\.3\s+=>\s+\/usr\/lib\/libcrypto\.so\.3\s+\(/m.test(linkage) ||
    /not found|Error loading shared library|Error relocating/.test(linkage)
  ) {
    throw new Error(
      'Node runtime does not use the required ABI and patched shared OpenSSL libraries',
    );
  }
}
