import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function assertDigest(file, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(file) !== expected) {
    throw new Error(`SHA256 mismatch: ${file}`);
  }
}

export function assertSignature(status, expected) {
  if (!/^[A-F0-9]{40}$/.test(expected)) throw new Error('Invalid pinned signer fingerprint');
  const valid = status.split('\n').filter((line) => line.startsWith('[GNUPG:] VALIDSIG '));
  if (valid.length !== 1 || valid[0].trim().split(/\s+/).at(-1) !== expected) {
    throw new Error('Source signature does not match the pinned primary signing key');
  }
  if (/\[GNUPG:\] (?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY)\b/.test(status)) {
    throw new Error('Source signature is invalid, expired or revoked');
  }
}

// Upstream identities supplement (never replace) the actual image's Alpine/npm
// SBOM. Archive hashes are attached to distribution references, not falsely
// attributed to installed executables. Binary hashes are measured after build.
export function sourceBom(components) {
  if (
    components.length !== 2 ||
    new Set(components.map((component) => component.name)).size !== 2 ||
    !components.some((component) => component.name === 'ffmpeg') ||
    !components.some((component) => component.name === 'imagemagick')
  ) {
    throw new Error('Source inventory must contain both media applications exactly once');
  }
  for (const component of components) {
    if (
      !component.cpe?.startsWith(`cpe:2.3:a:${component.name}:${component.name}:`) ||
      !/^[a-f0-9]{64}$/.test(component.sourceSha256) ||
      component.binaries.length === 0 ||
      component.binaries.some((path) => !/^[a-f0-9]{64}$/.test(component.binaryHashes?.[path]))
    ) {
      throw new Error(`Incomplete upstream or executable identity: ${component.name}`);
    }
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      tools: {
        components: [{ type: 'application', name: 'kinetra-media-source-inventory', version: '1' }],
      },
    },
    components: components.map((component) => ({
      type: 'application',
      'bom-ref': `pkg:generic/${component.name}@${component.version}`,
      name: component.name,
      version: component.version,
      purl: `pkg:generic/${component.name}@${component.version}`,
      cpe: component.cpe,
      licenses: [{ license: { id: component.license } }],
      externalReferences: [
        { type: 'website', url: component.url },
        {
          type: 'distribution',
          url: component.sourceUrl,
          hashes: [{ alg: 'SHA-256', content: component.sourceSha256 }],
        },
      ],
      evidence: { occurrences: component.binaries.map((path) => ({ location: `/${path}` })) },
      properties: [
        { name: 'kinetra:source:signer', value: component.signerFingerprint },
        { name: 'kinetra:source:signature', value: component.signatureUrl },
        { name: 'kinetra:build:configure', value: JSON.stringify(component.configure) },
        { name: 'kinetra:package:apk-version', value: component.apkVersion },
        ...Object.entries(component.binaryHashes).map(([path, hash]) => ({
          name: `kinetra:binary:sha256:/${path}`,
          value: hash,
        })),
      ],
    })),
  };
}
