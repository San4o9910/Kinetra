// Runs against the compiled application inside the actual final image.
// Synthetic inputs only; no database, provider credentials or network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Verify the executable actually loaded by the final image. The base image's
// bundled OpenSSL is replaced, so an APK-only version check is insufficient.
const nodeBuild = JSON.parse(readFileSync('/usr/share/kinetra-node/runtime.json', 'utf8'));
assert.equal(nodeBuild.schemaVersion, 1);
assert.equal(process.versions.node, '22.23.2');
assert.equal(process.config.variables.node_shared_openssl, true);
assert.match(process.versions.openssl, /^3[.]5[.](8|9|[1-9][0-9]+)$/);
assert.equal(nodeBuild.runtime.node_shared_openssl, true);
assert.equal(nodeBuild.runtime.versions.node, process.versions.node);
assert.equal(nodeBuild.runtime.versions.openssl, process.versions.openssl);
assert.equal(
  createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
  nodeBuild.binarySha256,
);
const linkage = execFileSync('ldd', [process.execPath], { encoding: 'utf8', timeout: 10_000 });
for (const library of ['libssl.so.3', 'libcrypto.so.3']) {
  assert.ok(linkage.split('\n').some((line) => line.trim().startsWith(`${library} => /`)));
}
assert.equal(
  createHash('sha256').update('abc').digest('hex'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
);
console.log('KINETRA_FINAL_NODE_SHARED_PATCHED_OPENSSL=PASS');
console.log(JSON.stringify({ nodeBuild, runtimeLinkage: linkage }));

const application = pathToFileURL(`${process.cwd()}/apps/backend/dist/`);
const { BcryptPasswordHasher } = await import(new URL('auth/password.js', application));
const { ImageMagickChatImageProcessor, ChatMediaError } = await import(
  new URL('chat/media.js', application)
);
const hasher = new BcryptPasswordHasher(4);
const syntheticPassword = 'kinetra-image-smoke-синтетический';
const hash = await hasher.hash(syntheticPassword);
assert.equal(await hasher.compare(syntheticPassword, hash), true);
assert.equal(await hasher.compare(`${syntheticPassword}-wrong`, hash), false);

const processor = new ImageMagickChatImageProcessor();
const commandOptions = { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 };
for (const format of ['jpeg', 'png', 'webp']) {
  const input = execFileSync(
    'convert',
    ['-size', '200x100', 'xc:white', '-set', 'comment', 'synthetic-private-note', `${format}:-`],
    commandOptions,
  );
  const result = await processor.normalize(input);
  assert.equal(result.mimeType, 'image/webp');
  assert.equal(result.width, 200);
  assert.equal(result.height, 100);
  assert.equal(result.bytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(result.bytes.subarray(8, 12).toString(), 'WEBP');
  assert.ok(result.bytes.length > 0 && result.bytes.length <= 4 * 1024 * 1024);
  const comment = execFileSync('identify', ['-format', '%c', '-'], {
    ...commandOptions,
    input: result.bytes,
  }).toString();
  assert.equal(comment, '');
}
const largeInput = execFileSync(
  'convert',
  ['-size', '3072x1024', 'xc:white', 'png:-'],
  commandOptions,
);
const resized = await processor.normalize(largeInput);
assert.equal(resized.width, 2048);
assert.ok(resized.height >= 682 && resized.height <= 683);
await assert.rejects(
  processor.normalize(Buffer.from('not an image')),
  (error) => error instanceof ChatMediaError && error.statusCode >= 400 && error.statusCode < 500,
);
const animation = execFileSync(
  'convert',
  ['-delay', '10', '-size', '2x2', 'xc:white', 'xc:black', '-loop', '0', 'webp:-'],
  commandOptions,
);
await assert.rejects(
  processor.normalize(animation),
  (error) => error instanceof ChatMediaError && error.code === 'CHAT_PHOTO_UNSUPPORTED',
);
const video = '/tmp/kinetra-application-smoke.mp4';
execFileSync(
  'ffmpeg',
  [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=16x16:d=0.2',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    video,
  ],
  commandOptions,
);
const probe = JSON.parse(
  execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video],
    commandOptions,
  ).toString(),
);
assert.deepEqual(probe.streams.map((stream) => stream.codec_name).sort(), ['aac', 'h264']);
assert.ok(Number(probe.format.duration) > 0 && Number(probe.format.duration) < 1);
console.log('KINETRA_FINAL_IMAGE_BCRYPT_AND_PHOTO_NORMALIZATION=PASS');
console.log('KINETRA_FINAL_IMAGE_MP4_H264_AAC=PASS');
