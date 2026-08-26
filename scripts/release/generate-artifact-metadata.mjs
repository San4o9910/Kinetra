import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  APP_SOURCE_COMMIT,
  APP_SOURCE_TREE,
  ReleaseContractError,
  SHA256_PATTERN,
  normalizeRepoRelative,
  validateArtifactIdentity,
} from './contracts.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const GENERATED = 'GENERATED_AT_RUNTIME';

function parseArguments(argv) {
  const result = {
    output: '.release-output/artifact-identity.json',
    artifact: null,
    manifest: null,
    sbom: null,
  };
  const known = new Set(['--output', '--artifact', '--manifest', '--sbom']);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!known.has(argument)) throw new ReleaseContractError(`Unknown argument: ${argument}`);
    if (seen.has(argument))
      throw new ReleaseContractError(`${argument} may be specified only once`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
      throw new ReleaseContractError(`${argument} requires a path`);
    result[argument.slice(2)] = value;
    index += 1;
  }
  return result;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveExistingFile(input) {
  const relative = normalizeRepoRelative(input);
  const root = await realpath(repositoryRoot);
  const candidate = path.resolve(root, relative);
  if (!isWithin(root, candidate))
    throw new ReleaseContractError(`${input} escapes repository root`);
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink()) throw new ReleaseContractError(`${input} must not be a symbolic link`);
  if (!stat.isFile()) throw new ReleaseContractError(`${input} must be a regular file`);
  const resolved = await realpath(candidate);
  if (!isWithin(root, resolved))
    throw new ReleaseContractError(`${input} resolves outside repository`);
  return { relative, resolved, size: stat.size };
}

async function prepareOutput(input) {
  const relative = normalizeRepoRelative(input, 'output path');
  if (!relative.startsWith('.release-output/') || relative.endsWith('/')) {
    throw new ReleaseContractError('output path must be a file beneath .release-output/');
  }
  const root = await realpath(repositoryRoot);
  const candidate = path.resolve(root, relative);
  if (!isWithin(root, candidate))
    throw new ReleaseContractError('output path escapes repository root');

  let current = root;
  for (const segment of path.dirname(relative).split('/')) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new ReleaseContractError(`${segment} output ancestor is a symlink`);
      if (!stat.isDirectory())
        throw new ReleaseContractError(`${segment} output ancestor is not a directory`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      break;
    }
  }
  await mkdir(path.dirname(candidate), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(candidate));
  if (!isWithin(root, parent))
    throw new ReleaseContractError('output parent resolves outside repository');
  try {
    await lstat(candidate);
    throw new ReleaseContractError(`${relative} already exists; refusing to overwrite evidence`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { relative, resolved: candidate };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  const stream = createReadStream(file.resolved, { flags: 'r' });
  for await (const chunk of stream) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function hashBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function git(arguments_, { allowExit = false } = {}) {
  const result = spawnSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error?.code === 'ENOENT') throw new ReleaseContractError('git is unavailable');
  if (result.error)
    throw new ReleaseContractError(`git ${arguments_.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0 && !allowExit) {
    throw new ReleaseContractError(
      `git ${arguments_.join(' ')} failed: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  return result;
}

function gitIdentity() {
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=no']).stdout.trim();
  if (dirty.length > 0) {
    throw new ReleaseContractError(
      'tracked worktree changes are present; HEAD cannot truthfully identify this release definition',
    );
  }
  const releaseDefinitionCommit = git(['rev-parse', '--verify', 'HEAD']).stdout.trim();
  const releaseDefinitionTree = git(['rev-parse', '--verify', 'HEAD^{tree}']).stdout.trim();
  const sourceTree = git(['rev-parse', '--verify', `${APP_SOURCE_COMMIT}^{tree}`]).stdout.trim();
  if (sourceTree !== APP_SOURCE_TREE) {
    throw new ReleaseContractError(
      `application source tree mismatch: expected ${APP_SOURCE_TREE}, got ${sourceTree}`,
    );
  }
  const ancestor = git(
    ['merge-base', '--is-ancestor', APP_SOURCE_COMMIT, releaseDefinitionCommit],
    { allowExit: true },
  );
  if (ancestor.status !== 0) {
    throw new ReleaseContractError(
      'the pinned T14 application commit is not an ancestor of this release definition',
    );
  }
  return { releaseDefinitionCommit, releaseDefinitionTree };
}

function isOciManifest(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.schemaVersion === 2 &&
    typeof value.mediaType === 'string' &&
    /vnd\.(?:oci|docker)\.(?:image\.)?(?:manifest|index|manifest\.list)\.v\d\+json/.test(
      value.mediaType,
    )
  );
}

async function readManifestEvidence(input) {
  const file = await resolveExistingFile(input);
  if (file.size > 16 * 1024 * 1024) {
    throw new ReleaseContractError('manifest evidence exceeds the 16 MiB limit');
  }
  const bytes = await readFile(file.resolved);
  return { file, ...parseManifestEvidenceBytes(bytes) };
}

export function parseManifestEvidenceBytes(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new ReleaseContractError(`manifest evidence is malformed JSON: ${error.message}`);
  }

  let manifestDigest;
  let evidenceKind;
  if (isOciManifest(value)) {
    manifestDigest = hashBytes(bytes);
    evidenceKind = 'OCI_MANIFEST_BYTES';
  } else {
    const reported = value?.['containerimage.digest'];
    if (typeof reported !== 'string' || !SHA256_PATTERN.test(reported)) {
      throw new ReleaseContractError(
        'manifest evidence must be exact OCI/Docker manifest bytes or BuildKit metadata with containerimage.digest',
      );
    }
    manifestDigest = reported;
    evidenceKind = 'BUILDKIT_REPORTED_OCI_MANIFEST_DIGEST';
  }
  return {
    manifestDigest,
    evidenceKind,
    evidenceDigest: hashBytes(bytes),
  };
}

async function classifyArtifact(input) {
  const file = await resolveExistingFile(input);
  const digest = await hashFile(file);
  if (file.relative.toLowerCase().endsWith('.json') && file.size <= 16 * 1024 * 1024) {
    let value;
    try {
      value = JSON.parse((await readFile(file.resolved)).toString('utf8'));
    } catch (error) {
      throw new ReleaseContractError(`JSON artifact is malformed: ${error.message}`);
    }
    if (!isOciManifest(value)) {
      throw new ReleaseContractError(
        'a JSON artifact must contain exact OCI/Docker manifest bytes',
      );
    }
    return { file, digest, kind: 'LOCAL_OCI_MANIFEST_UNPUBLISHED' };
  }
  return { file, digest, kind: 'LOCAL_ARCHIVE_SHA256_NOT_REGISTRY_MANIFEST' };
}

function builderIdentity() {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') &&
    /^\d+$/.test(runId ?? '') &&
    /^\d+$/.test(runAttempt ?? '')
  ) {
    return `github-actions:${repository}:run-${runId}:attempt-${runAttempt}`;
  }
  return `local:${process.platform}/${process.arch}:${process.release.name}-${process.version}`;
}

async function writeExclusive(file, bytes) {
  await writeFile(file.resolved, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

export async function generateArtifactMetadata(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const identity = gitIdentity();
  const output = await prepareOutput(options.output);
  const provenanceName = output.relative.endsWith('.json')
    ? `${output.relative.slice(0, -5)}.provenance.json`
    : `${output.relative}.provenance.json`;
  const provenanceOutput = await prepareOutput(provenanceName);

  const artifact = options.artifact ? await classifyArtifact(options.artifact) : null;
  const manifest = options.manifest ? await readManifestEvidence(options.manifest) : null;
  const sbom = options.sbom ? await resolveExistingFile(options.sbom) : null;
  const sbomDigest = sbom ? await hashFile(sbom) : GENERATED;

  const artifactDigest = artifact?.digest ?? manifest?.manifestDigest ?? GENERATED;
  const artifactDigestKind =
    artifact?.kind ?? (manifest ? 'LOCAL_OCI_MANIFEST_UNPUBLISHED' : 'NOT_GENERATED');
  const manifestDigest = manifest?.manifestDigest ?? GENERATED;
  const builder = builderIdentity();
  const createdAt = new Date().toISOString();

  const provenance = {
    contractVersion: 'kinetra.release.local-unsigned-provenance/v1',
    sourceCommit: APP_SOURCE_COMMIT,
    sourceTree: APP_SOURCE_TREE,
    ...identity,
    artifactReference: 'UNPUBLISHED',
    artifactDigest,
    artifactDigestKind,
    artifactEvidence: artifact
      ? { path: artifact.file.relative, sha256: artifact.digest }
      : 'NOT_PROVIDED',
    manifestDigest,
    manifestEvidence: manifest
      ? {
          path: manifest.file.relative,
          sha256: manifest.evidenceDigest,
          kind: manifest.evidenceKind,
        }
      : 'NOT_PROVIDED',
    sbomDigest,
    sbomEvidence: sbom ? { path: sbom.relative, sha256: sbomDigest } : 'NOT_PROVIDED',
    builder,
    createdAt,
    publishStatus: false,
    signatureStatus: 'NOT_SIGNED_DRY_RUN',
  };
  const provenanceBytes = `${JSON.stringify(provenance, null, 2)}\n`;
  const provenanceDigest = hashBytes(Buffer.from(provenanceBytes, 'utf8'));

  const metadata = {
    contractVersion: 'kinetra.release.artifact-identity/v1',
    sourceCommit: APP_SOURCE_COMMIT,
    sourceTree: APP_SOURCE_TREE,
    ...identity,
    artifactReference: 'UNPUBLISHED',
    artifactDigest,
    artifactDigestKind,
    manifestDigest,
    sbomDigest,
    provenanceReference: `LOCAL_UNSIGNED_BUILD_PROVENANCE:${provenanceDigest}`,
    signatureReference: 'NOT_SIGNED_DRY_RUN',
    builder,
    createdAt,
    publishStatus: false,
  };
  validateArtifactIdentity(metadata);

  await writeExclusive(provenanceOutput, provenanceBytes);
  await writeExclusive(output, `${JSON.stringify(metadata, null, 2)}\n`);
  return {
    status: 'UNPUBLISHED',
    metadataFile: output.relative,
    provenanceFile: provenanceOutput.relative,
    metadata,
  };
}

async function main() {
  try {
    const report = await generateArtifactMetadata();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ status: 'FAIL', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
