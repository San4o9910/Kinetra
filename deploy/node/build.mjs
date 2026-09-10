import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDigest, assertRuntime, assertSignedChecksum, sha256 } from './verify.mjs';

// Only the isolated Alpine image build stage executes this recipe.
const recipe = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(join(recipe, 'source.json'), 'utf8'));
const work = '/node-build';
const output = '/node-output';
const evidence = join(output, 'evidence');
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', timeout: 180_000, ...options });
const capture = (command, args, options = {}) =>
  run(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const osRelease = readFileSync('/etc/os-release', 'utf8');
if (
  process.getuid() !== 0 ||
  !/^ID=alpine$/m.test(osRelease) ||
  !/^VERSION_ID=3\.24\./m.test(osRelease) ||
  manifest.schemaVersion !== 1 ||
  manifest.version !== '22.23.2' ||
  manifest.parallelJobs !== 4 ||
  manifest.compileTimeoutMs !== 5_400_000
) {
  throw new Error('Node must be built in the reviewed Alpine 3.24 stage with the bounded recipe');
}
run('apk', [
  'info',
  '--exists',
  'openssl-dev>=3.5.8-r0',
  'libcrypto3>=3.5.8-r0',
  'libssl3>=3.5.8-r0',
]);
mkdirSync(work);
mkdirSync(join(output, 'bin'), { recursive: true });
mkdirSync(evidence, { recursive: true });
const totalMemoryBytes = totalmem();
const constrainedMemoryBytes = process.constrainedMemory();
const resources = {
  schemaVersion: 1,
  availableParallelism: availableParallelism(),
  totalMemoryBytes,
  constrainedMemoryBytes,
  effectiveMemoryBytes:
    constrainedMemoryBytes > 0
      ? Math.min(totalMemoryBytes, constrainedMemoryBytes)
      : totalMemoryBytes,
  minimumMemoryBytes: 8 * 1024 ** 3,
  parallelJobs: manifest.parallelJobs,
  compileTimeoutMs: manifest.compileTimeoutMs,
};
save(join(evidence, 'build-resources.json'), resources);
process.stdout.write(`KINETRA_NODE_BUILD_RESOURCES=${JSON.stringify(resources)}\n`);
if (
  resources.availableParallelism < manifest.parallelJobs ||
  resources.effectiveMemoryBytes < resources.minimumMemoryBytes
) {
  throw new Error('The four-job Node build requires at least four available CPUs and 8 GiB memory');
}
mkdirSync(join(work, 'gnupg'), { mode: 0o700 });
const buildEnv = { ...process.env, GNUPGHOME: join(work, 'gnupg') };
const archive = join(work, manifest.sourceFile);
const signedChecksums = join(work, 'SHASUMS256.txt.asc');
for (const [url, destination] of [
  [manifest.sourceUrl, archive],
  [manifest.signedChecksumsUrl, signedChecksums],
]) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'nodejs.org' ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('Node source must come from the reviewed HTTPS release URL');
  }
  run('curl', [
    '--fail',
    '--show-error',
    '--silent',
    '--location',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '--max-time',
    '180',
    '--output',
    destination,
    url,
  ]);
}
assertDigest(archive, manifest.sourceSha256);
assertDigest(signedChecksums, manifest.signedChecksumsSha256);
const key = join(recipe, manifest.keyFile);
assertDigest(key, manifest.keySha256);
const keyring = join(work, 'release.gpg');
run('gpg', ['--batch', '--no-options', '--dearmor', '--output', keyring, key], { env: buildEnv });
const checksums = join(work, 'SHASUMS256.txt');
const status = capture(
  'gpgv',
  ['--keyring', keyring, '--status-fd', '1', '--output', checksums, signedChecksums],
  { env: buildEnv },
);
assertSignedChecksum(status, readFileSync(checksums, 'utf8'), manifest);
run('tar', ['-xJf', archive, '-C', work]);
const cwd = join(work, manifest.sourceDirectory);
run('python3', ['configure.py', ...manifest.configure], { cwd, env: buildEnv });
run('make', [`-j${manifest.parallelJobs}`, 'V='], {
  cwd,
  env: buildEnv,
  timeout: manifest.compileTimeoutMs,
});
const binary = join(output, 'bin', 'node');
cpSync(join(cwd, 'out/Release/node'), binary);
chmodSync(binary, 0o755);
const runtime = JSON.parse(
  capture(binary, [
    '-p',
    'JSON.stringify({versions:process.versions,node_shared_openssl:process.config.variables.node_shared_openssl})',
  ]),
);
const ldd = capture('ldd', [binary]);
assertRuntime(runtime, ldd, manifest);
const binarySha256 = sha256(binary);
save(join(evidence, 'runtime.json'), {
  schemaVersion: 1,
  runtime,
  binarySha256,
  sourceSha256: manifest.sourceSha256,
  configure: manifest.configure,
  linkage: { ldd },
  binaryPath: '/usr/local/bin/node',
});
writeFileSync(join(evidence, 'signature-status.txt'), status);
writeFileSync(join(evidence, 'builder-apk-inventory.txt'), capture('apk', ['info', '-vv']));
cpSync(signedChecksums, join(evidence, 'SHASUMS256.txt.asc'));
cpSync(checksums, join(evidence, 'SHASUMS256.txt'));
cpSync(key, join(evidence, 'node-release-key.asc'));
cpSync(join(cwd, 'LICENSE'), join(evidence, 'LICENSE'));
for (const path of ['source.json', 'build.mjs', 'verify.mjs'])
  cpSync(join(recipe, path), join(evidence, path));
save(join(evidence, 'node-source.cdx.json'), {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  components: [
    {
      type: 'application',
      'bom-ref': `pkg:generic/nodejs@${manifest.version}`,
      name: 'node.js',
      version: manifest.version,
      purl: `pkg:generic/nodejs@${manifest.version}`,
      cpe: `cpe:2.3:a:nodejs:node.js:${manifest.version}:*:*:*:*:*:*:*`,
      licenses: [{ license: { id: 'MIT' } }],
      hashes: [{ alg: 'SHA-256', content: binarySha256 }],
      externalReferences: [
        {
          type: 'distribution',
          url: manifest.sourceUrl,
          hashes: [{ alg: 'SHA-256', content: manifest.sourceSha256 }],
        },
      ],
      evidence: { occurrences: [{ location: '/usr/local/bin/node' }] },
      properties: [
        { name: 'kinetra:source:signer', value: manifest.signerFingerprint },
        { name: 'kinetra:build:configure', value: JSON.stringify(manifest.configure) },
        { name: 'kinetra:runtime:openssl', value: runtime.versions.openssl },
        { name: 'kinetra:runtime:shared-openssl', value: 'true' },
      ],
    },
  ],
});
