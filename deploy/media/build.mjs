import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDigest, assertSignature, sha256, sourceBom } from './inventory.mjs';

// Container build stage only. No application credentials or provider calls.
const recipe = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(join(recipe, 'sources.json'), 'utf8'));
const work = '/media-build';
const output = '/media-output';
const evidence = join(output, 'evidence');
const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options });
const capture = (command, args, options = {}) =>
  run(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

if (process.getuid() !== 0 || !/^ID=alpine$/m.test(readFileSync('/etc/os-release', 'utf8'))) {
  throw new Error('Media packages must be built as root inside the Alpine image build stage');
}
if (manifest.schemaVersion !== 1 || manifest.components.length !== 2) {
  throw new Error('Unexpected source inventory');
}
mkdirSync(work, { recursive: true });
mkdirSync(evidence, { recursive: true });
mkdirSync(join(work, 'gnupg'), { mode: 0o700 });
const buildEnv = {
  ...process.env,
  SOURCE_DATE_EPOCH: String(manifest.sourceDateEpoch),
  GNUPGHOME: join(work, 'gnupg'),
  CFLAGS: '-O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIC',
  LDFLAGS: '-Wl,-z,relro,-z,now',
};
const architecture = capture('apk', ['--print-arch']).trim();
const privateKey = join(work, 'local-package-signing.pem');
const publicKey = join(output, 'kinetra-media.rsa.pub');
run('openssl', ['genrsa', '-out', privateKey, '3072']);
run('openssl', ['rsa', '-in', privateKey, '-pubout', '-out', publicKey]);
const results = [];

function removeBuildFiles(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) removeBuildFiles(child);
    else if (entry.isFile() && /\.(?:a|la)$/.test(entry.name)) rmSync(child);
  }
}

function sonames(root, flag, format) {
  return new Set(
    capture('scanelf', [flag, '--nobanner', '--symlink', '--format', format, '--recursive', root])
      .split(/[\s,]+/)
      .filter((value) => value && value !== '-')
      .map((value) => {
        if (!/^[a-zA-Z0-9_.+-]+$/.test(value)) throw new Error(`Invalid SONAME: ${value}`);
        return value;
      }),
  );
}

for (const component of manifest.components) {
  const root = join(work, `${component.name}-root`);
  const archive = join(work, `${component.name}.tar.xz`);
  const signature = `${archive}.asc`;
  const key = join(recipe, component.keyFile);
  assertDigest(key, component.keySha256);
  for (const [url, destination] of [
    [component.sourceUrl, archive],
    [component.signatureUrl, signature],
  ]) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
      throw new Error('Unsafe source URL');
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
  assertDigest(archive, component.sourceSha256);
  const keyring = join(work, `${component.name}.gpg`);
  run('gpg', ['--batch', '--no-options', '--dearmor', '--output', keyring, key], { env: buildEnv });
  const status = capture('gpgv', ['--keyring', keyring, '--status-fd', '1', signature, archive], {
    env: buildEnv,
  });
  assertSignature(status, component.signerFingerprint);
  writeFileSync(join(evidence, `${component.name}.signature-status.txt`), status);
  run('tar', ['-xJf', archive, '-C', work]);
  const cwd = join(work, component.sourceDirectory);
  run('./configure', component.configure, { cwd, env: buildEnv });
  run('make', ['-j2'], { cwd, env: buildEnv });
  run('make', ['install', `DESTDIR=${root}`], { cwd, env: buildEnv });
  for (const path of [
    'usr/include',
    'usr/lib/pkgconfig',
    'usr/share/doc',
    'usr/share/man',
    'usr/bin/MagickCore-config',
    'usr/bin/MagickWand-config',
  ]) {
    rmSync(join(root, path), { recursive: true, force: true });
  }
  removeBuildFiles(root);
  const licenseDir = join(root, 'usr/share/licenses', component.name);
  mkdirSync(licenseDir, { recursive: true });
  cpSync(join(cwd, component.licenseFile), join(licenseDir, 'LICENSE'));
  // #F suppresses scanelf's implicit filename suffix. The declared SONAME,
  // not merely ET_DYN (also used by PIE executables), identifies a provider.
  const provides = sonames(root, '--soname', '%S#F');
  const depends = [...sonames(root, '--needed', '%n#F')]
    .filter((name) => !provides.has(name))
    .sort();
  const binaryHashes = Object.fromEntries(
    component.binaries.map((path) => [path, sha256(join(root, path))]),
  );
  const record = {
    ...component,
    binaryHashes,
    architecture,
    depends,
    provides: [...provides].sort(),
  };
  const packageEvidence = join(root, 'usr/share/kinetra-media', component.name);
  mkdirSync(packageEvidence, { recursive: true });
  save(join(packageEvidence, 'source-build.json'), record);
  cpSync(signature, join(packageEvidence, 'source.tar.xz.asc'));
  cpSync(key, join(packageEvidence, 'upstream-public-key.asc'));
  const packagePath = join(output, `${component.name}-${component.apkVersion}.apk`);
  run(
    'apk',
    [
      'mkpkg',
      '--files',
      root,
      '--output',
      packagePath,
      '--sign-key',
      privateKey,
      '--info',
      `name:${component.name}`,
      '--info',
      `version:${component.apkVersion}`,
      '--info',
      `arch:${architecture}`,
      '--info',
      `origin:${component.name}`,
      '--info',
      `description:Kinetra build of verified upstream ${component.name} source`,
      '--info',
      `license:${component.license}`,
      '--info',
      `url:${component.url}`,
      '--info',
      `depends:${depends.map((name) => `so:${name}`).join(' ')}`,
      '--info',
      `provides:${[...provides]
        .sort()
        .map((name) => `so:${name}=0`)
        .join(' ')}`,
      '--info',
      `build-time:${manifest.sourceDateEpoch}`,
    ],
    { env: buildEnv },
  );
  results.push({ ...record, apkSha256: sha256(packagePath) });
}

// This key signs only this build's local packages. It is not an upstream release
// signature or publication attestation; only the public key leaves this stage.
rmSync(privateKey);
save(join(evidence, 'source-builds.json'), { schemaVersion: 1, components: results });
save(join(evidence, 'source-components.cdx.json'), sourceBom(results));
writeFileSync(join(evidence, 'builder-apk-inventory.txt'), capture('apk', ['info', '-vv']));
cpSync(join(recipe, 'sources.json'), join(evidence, 'sources.json'));
cpSync(join(recipe, 'build.mjs'), join(evidence, 'build.mjs'));
cpSync(join(recipe, 'inventory.mjs'), join(evidence, 'inventory.mjs'));
