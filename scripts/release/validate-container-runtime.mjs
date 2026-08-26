import { spawnSync } from 'node:child_process';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  APP_SOURCE_COMMIT,
  APP_SOURCE_TREE,
  FFMPEG_BINARY_VERSION,
  FFMPEG_PACKAGE_VERSION,
  IMAGEMAGICK_BINARY_VERSION,
  IMAGEMAGICK_PACKAGE_VERSION,
  MIGRATION_012_SHA256,
  NODE_RUNTIME_VERSION,
  ReleaseContractError,
  TINI_BINARY_VERSION,
  TINI_PACKAGE_VERSION,
  findSecretMaterial,
  normalizeRepoRelative,
} from './contracts.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const RELEASE_ID = /^[0-9a-f]{40}$/;

function parseArguments(argv) {
  const result = { image: null, output: null, releaseCommit: null, releaseTree: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument !== '--image' &&
      argument !== '--output' &&
      argument !== '--release-commit' &&
      argument !== '--release-tree'
    ) {
      throw new ReleaseContractError(`Unknown argument: ${argument}`);
    }
    const key = argument
      .slice(2)
      .replace(/-([a-z])/g, (_match, character) => character.toUpperCase());
    if (result[key] !== null)
      throw new ReleaseContractError(`${argument} may be specified only once`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
      throw new ReleaseContractError(`${argument} requires a value`);
    result[key] = value;
    index += 1;
  }
  if (!IMAGE_ID.test(result.image ?? '')) {
    throw new ReleaseContractError(
      '--image must be an exact local sha256:<64 lowercase hex> image ID',
    );
  }
  if (!RELEASE_ID.test(result.releaseCommit ?? '')) {
    throw new ReleaseContractError('--release-commit must be exact 40-character lowercase hex');
  }
  if (!RELEASE_ID.test(result.releaseTree ?? '')) {
    throw new ReleaseContractError('--release-tree must be exact 40-character lowercase hex');
  }
  return result;
}

function defaultDocker(arguments_, options = {}) {
  const result = spawnSync('docker', arguments_, {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function dockerUnavailable(result) {
  return (
    result.error?.code === 'ENOENT' ||
    /cannot connect to the docker daemon|is the docker daemon running|error during connect|permission denied.*docker/i.test(
      `${result.stderr}\n${result.error?.message ?? ''}`,
    )
  );
}

function runProbe(image, command, arguments_, docker) {
  return docker(
    [
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--cap-drop=ALL',
      '--security-opt',
      'no-new-privileges',
      '--entrypoint',
      command,
      image,
      ...arguments_,
    ],
    { timeout: 120_000 },
  );
}

export function inspectRuntimeConfiguration(inspect, { releaseCommit, releaseTree } = {}) {
  const findings = [];
  const config = inspect?.Config;
  if (config === null || typeof config !== 'object') return ['image Config is missing'];

  const user = typeof config.User === 'string' ? config.User.trim() : '';
  if (!user) findings.push('image final USER is missing');
  if (/^(?:0|root)(?::(?:0|root))?$/i.test(user)) findings.push('image final USER is root');
  if (config.WorkingDir !== '/app') findings.push('image WorkingDir must be /app');
  if (!isDeepStrictEqual(config.Entrypoint, ['/usr/bin/tini', '--'])) {
    findings.push('image Entrypoint does not match the role-neutral runtime contract');
  }
  if (!isDeepStrictEqual(config.Cmd, ['node', 'apps/backend/dist/server.js'])) {
    findings.push('image default Cmd does not match the API role');
  }
  if (config.Healthcheck !== undefined && config.Healthcheck !== null) {
    findings.push('role-neutral image must not define a shared Docker Healthcheck');
  }

  const environment = Array.isArray(config.Env) ? config.Env : [];
  if (!environment.includes('TRAINER_VIDEO_UPLOADS_ENABLED=false')) {
    findings.push('image does not keep TRAINER_VIDEO_UPLOADS_ENABLED=false');
  }
  for (const entry of environment) {
    const separator = entry.indexOf('=');
    const name = separator >= 0 ? entry.slice(0, separator) : entry;
    if (/(?:PASSWORD|SECRET|TOKEN|ACCESS_KEY)/i.test(name)) {
      findings.push(`image embeds forbidden secret-bearing environment variable ${name}`);
    }
  }

  const labels = config.Labels ?? {};
  if (labels['io.kinetra.app-source-commit'] !== APP_SOURCE_COMMIT) {
    findings.push('image application source commit label mismatch');
  }
  if (labels['io.kinetra.app-source-tree'] !== APP_SOURCE_TREE) {
    findings.push('image application source tree label mismatch');
  }
  if (!RELEASE_ID.test(releaseCommit ?? '')) {
    findings.push('expected release definition commit is missing or invalid');
  } else if (labels['io.kinetra.release-definition-commit'] !== releaseCommit) {
    findings.push('image release definition commit label mismatch');
  }
  if (!RELEASE_ID.test(releaseTree ?? '')) {
    findings.push('expected release definition tree is missing or invalid');
  } else if (labels['io.kinetra.release-definition-tree'] !== releaseTree) {
    findings.push('image release definition tree label mismatch');
  }
  if (labels['org.opencontainers.image.revision'] !== releaseCommit) {
    findings.push('OCI revision is not bound to the exact release definition commit');
  }
  if (labels['io.kinetra.migration-012.sha256'] !== MIGRATION_012_SHA256) {
    findings.push('image migration 012 checksum label mismatch');
  }
  return findings;
}

export async function validateContainerRuntime(
  image,
  { docker = defaultDocker, releaseCommit, releaseTree } = {},
) {
  if (!RELEASE_ID.test(releaseCommit ?? '') || !RELEASE_ID.test(releaseTree ?? '')) {
    throw new ReleaseContractError(
      'exact releaseCommit and releaseTree are required for runtime label verification',
    );
  }
  const availability = docker(['info', '--format', '{{json .ServerVersion}}'], { timeout: 30_000 });
  if (dockerUnavailable(availability)) {
    return {
      status: 'BLOCKED_BY_ENVIRONMENT',
      image,
      reason: 'Docker CLI or daemon is unavailable',
      mutationPerformed: false,
    };
  }
  if (availability.status !== 0) {
    return {
      status: 'BLOCKED_BY_ENVIRONMENT',
      image,
      reason: 'Docker daemon could not be queried',
      mutationPerformed: false,
    };
  }

  const inspection = docker(['image', 'inspect', image], { timeout: 30_000 });
  if (inspection.status !== 0) {
    return {
      status: 'BLOCKED_BY_ENVIRONMENT',
      image,
      reason: 'Exact image ID is not present locally; validator will not pull it',
      mutationPerformed: false,
    };
  }
  let inspect;
  try {
    const values = JSON.parse(inspection.stdout);
    if (!Array.isArray(values) || values.length !== 1) throw new Error('expected one image');
    [inspect] = values;
  } catch (error) {
    return {
      status: 'FAIL',
      image,
      findings: [`invalid docker inspect response: ${error.message}`],
    };
  }

  const findings = inspectRuntimeConfiguration(inspect, { releaseCommit, releaseTree });
  const history = docker([
    'image',
    'history',
    '--no-trunc',
    '--format',
    '{{json .CreatedBy}}',
    image,
  ]);
  if (history.status !== 0) {
    findings.push('docker image history could not be inspected');
  } else {
    for (const secret of findSecretMaterial(history.stdout)) {
      findings.push(`image history contains ${secret}`);
    }
    if (
      /\bchmod\s+(?:-R\s+)?777\b|\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b/i.test(history.stdout)
    ) {
      findings.push('image history contains an unsafe build command');
    }
  }
  if (findings.length > 0) return { status: 'FAIL', image, findings, mutationPerformed: false };

  const probes = [
    ['non-root-uid', '/usr/bin/id', ['-u'], (output) => /^\d+$/.test(output) && Number(output) > 0],
    ['node', '/usr/local/bin/node', ['--version'], (output) => output === NODE_RUNTIME_VERSION],
    [
      'ffmpeg',
      '/usr/bin/ffmpeg',
      ['-version'],
      (output) => output.startsWith(`ffmpeg version ${FFMPEG_BINARY_VERSION} `),
    ],
    [
      'ffprobe',
      '/usr/bin/ffprobe',
      ['-version'],
      (output) => output.startsWith(`ffprobe version ${FFMPEG_BINARY_VERSION} `),
    ],
    [
      'imagemagick-identify',
      '/usr/bin/identify',
      ['-version'],
      (output) => output.startsWith(`Version: ImageMagick ${IMAGEMAGICK_BINARY_VERSION} `),
    ],
    [
      'imagemagick-convert',
      '/usr/bin/convert',
      ['-version'],
      (output) => output.startsWith(`Version: ImageMagick ${IMAGEMAGICK_BINARY_VERSION} `),
    ],
    [
      'tini',
      '/usr/bin/tini',
      ['--version'],
      (output) => output.startsWith(`tini version ${TINI_BINARY_VERSION}`),
    ],
    [
      'ffmpeg-package',
      '/usr/bin/dpkg-query',
      ['-W', '-f=${Version}', 'ffmpeg'],
      (output) => output === FFMPEG_PACKAGE_VERSION,
    ],
    [
      'imagemagick-package',
      '/usr/bin/dpkg-query',
      ['-W', '-f=${Version}', 'imagemagick'],
      (output) => output === IMAGEMAGICK_PACKAGE_VERSION,
    ],
    [
      'tini-package',
      '/usr/bin/dpkg-query',
      ['-W', '-f=${Version}', 'tini'],
      (output) => output === TINI_PACKAGE_VERSION,
    ],
  ];
  const probeResults = {};
  for (const [name, command, arguments_, accepts] of probes) {
    const result = runProbe(image, command, arguments_, docker);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (dockerUnavailable(result)) {
      return {
        status: 'BLOCKED_BY_ENVIRONMENT',
        image,
        reason: `Docker became unavailable during ${name}`,
        mutationPerformed: true,
      };
    }
    const valid = result.status === 0 && accepts(output);
    probeResults[name] = { status: valid ? 'AVAILABLE' : 'FAIL' };
    if (!valid) findings.push(`${name} runtime probe failed`);
  }
  return findings.length > 0
    ? { status: 'FAIL', image, findings, probes: probeResults, mutationPerformed: true }
    : { status: 'PASS', image, probes: probeResults, mutationPerformed: true };
}

async function safeOutput(input) {
  const relative = normalizeRepoRelative(input, 'output path');
  if (!relative.startsWith('.release-output/')) {
    throw new ReleaseContractError('output must be beneath .release-output/');
  }
  const root = await realpath(repositoryRoot);
  const target = path.resolve(root, relative);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(target));
  const relation = path.relative(root, parent);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new ReleaseContractError('output parent resolves outside repository');
  }
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new ReleaseContractError('output is a symbolic link');
    throw new ReleaseContractError('output already exists; refusing to overwrite evidence');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target;
}

export async function runContainerRuntimeValidation(argv = process.argv.slice(2), options) {
  const arguments_ = parseArguments(argv);
  const report = await validateContainerRuntime(arguments_.image, {
    ...options,
    releaseCommit: arguments_.releaseCommit,
    releaseTree: arguments_.releaseTree,
  });
  if (arguments_.output !== null) {
    const target = await safeOutput(arguments_.output);
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  }
  return report;
}

async function main() {
  try {
    const report = await runContainerRuntimeValidation();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode =
      report.status === 'PASS' ? 0 : report.status === 'BLOCKED_BY_ENVIRONMENT' ? 2 : 1;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
