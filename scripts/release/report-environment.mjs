import { spawnSync } from 'node:child_process';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ReleaseContractError, normalizeRepoRelative } from './contracts.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');

const requirements = Object.freeze([
  { name: 'node', candidates: [['node', ['--version']]] },
  { name: 'npm', candidates: [['npm', ['--version']]] },
  { name: 'git', candidates: [['git', ['--version']]] },
  { name: 'bash', candidates: [['bash', ['--version']]] },
  { name: 'docker', candidates: [['docker', ['--version']]] },
  { name: 'postgresql-client', candidates: [['psql', ['--version']]] },
  { name: 'ffmpeg', candidates: [['ffmpeg', ['-version']]] },
  { name: 'ffprobe', candidates: [['ffprobe', ['-version']]] },
  { name: 'imagemagick-identify', candidates: [['identify', ['-version']]] },
  { name: 'imagemagick-convert', candidates: [['convert', ['-version']]] },
  { name: 'syft', candidates: [['syft', ['version', '-o', 'json']]] },
  { name: 'cosign', candidates: [['cosign', ['version']]] },
  { name: 'gitleaks', candidates: [['gitleaks', ['version']]] },
  { name: 'trivy', candidates: [['trivy', ['--version']]] },
  {
    name: 'chrome',
    candidates: [
      ['google-chrome', ['--version']],
      ['chromium', ['--version']],
      ['chromium-browser', ['--version']],
    ],
  },
]);

function defaultProbe(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) return { available: false, detail: result.error.code ?? result.error.message };
  if (result.status !== 0) {
    return { available: false, detail: result.stderr.trim() || `exit ${result.status}` };
  }
  const firstLine = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return { available: true, detail: firstLine?.slice(0, 512) ?? 'available' };
}

export function buildEnvironmentReport({ probe = defaultProbe } = {}) {
  const tools = {};
  for (const requirement of requirements) {
    let selected = null;
    const attempts = [];
    for (const [command, arguments_] of requirement.candidates) {
      const result = probe(command, arguments_);
      attempts.push({ command, ...result });
      if (result.available) {
        selected = { command, detail: result.detail };
        break;
      }
    }
    tools[requirement.name] = selected
      ? { status: 'AVAILABLE', ...selected }
      : { status: 'BLOCKED_BY_ENVIRONMENT', attempts };
  }
  const missing = Object.entries(tools)
    .filter(([, value]) => value.status === 'BLOCKED_BY_ENVIRONMENT')
    .map(([name]) => name);
  return {
    contractVersion: 'kinetra.release.environment-report/v1',
    status: missing.length === 0 ? 'AVAILABLE' : 'BLOCKED_BY_ENVIRONMENT',
    mutationPerformed: false,
    tools,
    blocked: missing,
  };
}

function parseArguments(argv) {
  if (argv.length === 0) return { output: null };
  if (argv.length !== 2 || argv[0] !== '--output') {
    throw new ReleaseContractError(
      'usage: report-environment.mjs [--output .release-output/file.json]',
    );
  }
  return { output: argv[1] };
}

async function safeOutput(input) {
  const relative = normalizeRepoRelative(input, 'output path');
  if (!relative.startsWith('.release-output/')) {
    throw new ReleaseContractError('output must be beneath .release-output/');
  }
  const root = await realpath(repositoryRoot);
  const target = path.resolve(root, relative);
  const relation = path.relative(root, target);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new ReleaseContractError('output escapes repository');
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(target));
  const parentRelation = path.relative(root, parent);
  if (parentRelation.startsWith('..') || path.isAbsolute(parentRelation)) {
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

export async function reportEnvironment(argv = process.argv.slice(2), options) {
  const arguments_ = parseArguments(argv);
  const report = buildEnvironmentReport(options);
  if (arguments_.output !== null) {
    const output = await safeOutput(arguments_.output);
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  }
  return report;
}

async function main() {
  try {
    const report = await reportEnvironment();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === 'BLOCKED_BY_ENVIRONMENT' ? 2 : 0;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
