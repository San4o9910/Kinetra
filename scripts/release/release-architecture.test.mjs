import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APP_SOURCE_COMMIT,
  APP_SOURCE_TREE,
  DEBIAN_SNAPSHOT,
  FFMPEG_BINARY_VERSION,
  FFMPEG_PACKAGE_VERSION,
  IMAGEMAGICK_BINARY_VERSION,
  IMAGEMAGICK_PACKAGE_VERSION,
  MIGRATION_012_SHA256,
  NODE_BASE_REFERENCE,
  NODE_RUNTIME_VERSION,
  TINI_BINARY_VERSION,
  TINI_PACKAGE_VERSION,
  findDuplicateJsonKeys,
  parseDigestPinnedReference,
  readSafeJson,
  readSafeText,
  validateArtifactIdentity,
  validateContainerfile,
  validateRenderedRuntimeUnit,
  validateRollbackTemplate,
  validateRuntimeUnitTemplate,
  validateWorkflowObject,
} from './contracts.mjs';
import { buildEnvironmentReport } from './report-environment.mjs';
import { parseManifestEvidenceBytes } from './generate-artifact-metadata.mjs';
import {
  inspectRuntimeConfiguration,
  validateContainerRuntime,
} from './validate-container-runtime.mjs';
import { loadYamlWorkflow } from './validate-release-architecture.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');
const digest = `sha256:${'a'.repeat(64)}`;
const releaseCommit = '1'.repeat(40);
const releaseTree = '2'.repeat(40);

async function json(file) {
  return JSON.parse(await readFile(path.join(repositoryRoot, file), 'utf8'));
}

async function runtimeTemplate(role) {
  const files = {
    api: 'release/templates/api.runtime.template.json',
    'video-verifier': 'release/templates/video-verifier.runtime.template.json',
    'video-cleanup': 'release/templates/video-cleanup.runtime.template.json',
  };
  return json(files[role]);
}

function rendered(template) {
  const value = structuredClone(template);
  value.spec.artifactReference = `ghcr.io/kinetra/backend@${digest}`;
  value.spec.artifactDigest = digest;
  value.spec.rollbackReference = `ghcr.io/kinetra/backend@sha256:${'b'.repeat(64)}`;
  value.spec.security.runAsUser = 10001;
  return value;
}

function artifactIdentity(overrides = {}) {
  return {
    contractVersion: 'kinetra.release.artifact-identity/v1',
    sourceCommit: APP_SOURCE_COMMIT,
    sourceTree: APP_SOURCE_TREE,
    releaseDefinitionCommit: 'c'.repeat(40),
    releaseDefinitionTree: 'd'.repeat(40),
    artifactReference: 'UNPUBLISHED',
    artifactDigest: 'GENERATED_AT_RUNTIME',
    artifactDigestKind: 'NOT_GENERATED',
    manifestDigest: 'GENERATED_AT_RUNTIME',
    sbomDigest: 'GENERATED_AT_RUNTIME',
    provenanceReference: `LOCAL_UNSIGNED_BUILD_PROVENANCE:sha256:${'e'.repeat(64)}`,
    signatureReference: 'NOT_SIGNED_DRY_RUN',
    builder: 'local:test',
    createdAt: '2026-08-25T00:00:00.000Z',
    publishStatus: false,
    ...overrides,
  };
}

function safeWorkflow() {
  return {
    name: 'release foundation',
    on: {
      workflow_dispatch: {
        inputs: {
          publish: { type: 'boolean', required: true, default: false },
          deploy: { type: 'boolean', required: true, default: false },
          migrate: { type: 'boolean', required: true, default: false },
          enable_feature_flag: { type: 'boolean', required: true, default: false },
        },
      },
    },
    permissions: { contents: 'read', actions: 'read' },
    jobs: {
      validate: {
        steps: [
          { uses: `actions/checkout@${'1'.repeat(40)}` },
          {
            env: { DISPATCH_COMMIT: '${{ github.sha }}' },
            run: 'git rev-parse HEAD\ngit rev-parse HEAD^{tree}',
          },
        ],
      },
    },
  };
}

function safeWorkflowText() {
  return [
    APP_SOURCE_COMMIT,
    APP_SOURCE_TREE,
    '${{ github.sha }}',
    'git rev-parse HEAD',
    'git rev-parse HEAD^{tree}',
  ].join('\n');
}

function runtimeInspect() {
  return {
    Config: {
      User: 'node',
      WorkingDir: '/app',
      Entrypoint: ['/usr/bin/tini', '--'],
      Cmd: ['node', 'apps/backend/dist/server.js'],
      Env: ['TRAINER_VIDEO_UPLOADS_ENABLED=false'],
      Labels: {
        'io.kinetra.app-source-commit': APP_SOURCE_COMMIT,
        'io.kinetra.app-source-tree': APP_SOURCE_TREE,
        'io.kinetra.release-definition-commit': releaseCommit,
        'io.kinetra.release-definition-tree': releaseTree,
        'io.kinetra.migration-012.sha256': MIGRATION_012_SHA256,
        'org.opencontainers.image.revision': releaseCommit,
      },
    },
  };
}

function successfulRuntimeDocker(outputOverrides = {}) {
  const outputs = {
    '/usr/bin/id': '1000\n',
    '/usr/local/bin/node': `${NODE_RUNTIME_VERSION}\n`,
    '/usr/bin/ffmpeg': `ffmpeg version ${FFMPEG_BINARY_VERSION} Copyright\n`,
    '/usr/bin/ffprobe': `ffprobe version ${FFMPEG_BINARY_VERSION} Copyright\n`,
    '/usr/bin/identify': `Version: ImageMagick ${IMAGEMAGICK_BINARY_VERSION} Q16 x86_64\n`,
    '/usr/bin/convert': `Version: ImageMagick ${IMAGEMAGICK_BINARY_VERSION} Q16 x86_64\n`,
    '/usr/bin/tini': `tini version ${TINI_BINARY_VERSION}\n`,
    'dpkg-query:ffmpeg': `${FFMPEG_PACKAGE_VERSION}\n`,
    'dpkg-query:imagemagick': `${IMAGEMAGICK_PACKAGE_VERSION}\n`,
    'dpkg-query:tini': `${TINI_PACKAGE_VERSION}\n`,
    ...outputOverrides,
  };
  return (arguments_) => {
    if (arguments_[0] === 'info') return { status: 0, stdout: '"28.0.0"\n', stderr: '' };
    if (arguments_[0] === 'image' && arguments_[1] === 'inspect') {
      return { status: 0, stdout: JSON.stringify([runtimeInspect()]), stderr: '' };
    }
    if (arguments_[0] === 'image' && arguments_[1] === 'history') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (arguments_[0] === 'run') {
      const entrypointIndex = arguments_.indexOf('--entrypoint');
      const command = arguments_[entrypointIndex + 1];
      const key = command === '/usr/bin/dpkg-query' ? `dpkg-query:${arguments_.at(-1)}` : command;
      return { status: 0, stdout: outputs[key] ?? '', stderr: '' };
    }
    throw new Error(`unexpected docker invocation: ${arguments_.join(' ')}`);
  };
}

test('all platform-neutral runtime templates satisfy their exact role contracts', async () => {
  for (const role of ['api', 'video-verifier', 'video-cleanup']) {
    validateRuntimeUnitTemplate(await runtimeTemplate(role));
  }
});

test('cleanup role explicitly depends on node only', async () => {
  const cleanup = await runtimeTemplate('video-cleanup');
  assert.deepEqual(cleanup.spec.requiredExecutables, ['node']);
  assert.equal(cleanup.spec.requiredExecutables.includes('ffprobe'), false);
});

test('all roles carry actual common production-parser secret references without invented values', async () => {
  for (const role of ['api', 'video-verifier', 'video-cleanup']) {
    const template = await runtimeTemplate(role);
    const names = template.spec.environment.secretReferences.map(
      (entry) => entry.environmentVariable,
    );
    for (const required of ['YUKASSA_SECRET_KEY', 'VAPID_PRIVATE_KEY']) {
      assert.ok(names.includes(required), `${role} is missing ${required}`);
    }
    assert.equal(names.includes('JWT_REFRESH_SECRET'), false);
    assert.equal(JSON.stringify(template).includes('actual-secret-value'), false);
  }
});

test('rollback template remains non-deployable and fail-closed', async () => {
  validateRollbackTemplate(await json('release/templates/rollback.runtime.template.json'));
});

test('rendered runtime requires digest pins and a positive numeric UID', async () => {
  const value = rendered(await runtimeTemplate('api'));
  validateRenderedRuntimeUnit(value);
  value.spec.security.runAsUser = '${RUNTIME_UID}';
  assert.throws(() => validateRenderedRuntimeUnit(value), /positive numeric UID/);
});

test('rendered runtime rejects digest placeholders and mutable references', async () => {
  const value = rendered(await runtimeTemplate('video-verifier'));
  value.spec.artifactReference = '${ARTIFACT_REPOSITORY}@${ARTIFACT_DIGEST}';
  assert.throws(() => validateRenderedRuntimeUnit(value), /placeholders/);
  value.spec.artifactReference = 'ghcr.io/kinetra/backend:latest';
  assert.throws(() => validateRenderedRuntimeUnit(value), /sha256/);
});

test('runtime rejects source, flag, command and executable weakening', async () => {
  const source = await runtimeTemplate('video-verifier');
  source.metadata.sourceTree = '0'.repeat(40);
  assert.throws(() => validateRuntimeUnitTemplate(source), /sourceTree mismatch/);

  const flag = await runtimeTemplate('api');
  flag.spec.environment.literals.TRAINER_VIDEO_UPLOADS_ENABLED = 'true';
  assert.throws(() => validateRuntimeUnitTemplate(flag), /must remain the string false/);

  const command = await runtimeTemplate('video-cleanup');
  command.spec.command[1] = 'apps/backend/dist/server.js';
  assert.throws(() => validateRuntimeUnitTemplate(command), /command does not match role/);

  const executable = await runtimeTemplate('video-cleanup');
  executable.spec.requiredExecutables.push('ffprobe');
  assert.throws(() => validateRuntimeUnitTemplate(executable), /requiredExecutables/);
});

test('artifact identity binds provenance and distinguishes local archive digest', () => {
  validateArtifactIdentity(
    artifactIdentity({
      artifactDigest: digest,
      artifactDigestKind: 'LOCAL_ARCHIVE_SHA256_NOT_REGISTRY_MANIFEST',
    }),
  );
  assert.throws(
    () =>
      validateArtifactIdentity(
        artifactIdentity({ provenanceReference: 'LOCAL_UNSIGNED_BUILD_PROVENANCE' }),
      ),
    /provenanceReference/,
  );
  assert.throws(
    () =>
      validateArtifactIdentity(
        artifactIdentity({ artifactDigest: digest, artifactDigestKind: 'NOT_GENERATED' }),
      ),
    /inconsistent/,
  );
});

test('manifest evidence extracts BuildKit OCI digest instead of hashing metadata JSON as a manifest', () => {
  const reportedDigest = `sha256:${'9'.repeat(64)}`;
  const evidence = parseManifestEvidenceBytes(
    Buffer.from(JSON.stringify({ 'containerimage.digest': reportedDigest, other: 'evidence' })),
  );
  assert.equal(evidence.manifestDigest, reportedDigest);
  assert.equal(evidence.evidenceKind, 'BUILDKIT_REPORTED_OCI_MANIFEST_DIGEST');
  assert.match(evidence.evidenceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(evidence.evidenceDigest, reportedDigest);
  assert.throws(() => parseManifestEvidenceBytes(Buffer.from('{}')), /containerimage.digest/);
});

test('digest reference parser rejects missing digest, placeholders and mutable tags', () => {
  assert.deepEqual(parseDigestPinnedReference(`ghcr.io/kinetra/backend@${digest}`), {
    repository: 'ghcr.io/kinetra/backend',
    digest,
  });
  assert.throws(() => parseDigestPinnedReference('ghcr.io/kinetra/backend:latest'), /sha256/);
  assert.throws(
    () => parseDigestPinnedReference(`ghcr.io/kinetra/backend:latest@${digest}`),
    /mutable tag/,
  );
  assert.throws(() => parseDigestPinnedReference('${IMAGE}@${DIGEST}'), /placeholders/);
});

test('repository Containerfile passes immutable and non-root checks', async () => {
  validateContainerfile(await readFile(path.join(repositoryRoot, 'Containerfile'), 'utf8'));
});

test('Containerfile validator rejects pin drift, mutable syntax, root and unsafe instructions', async () => {
  const original = await readFile(path.join(repositoryRoot, 'Containerfile'), 'utf8');
  assert.throws(
    () => validateContainerfile(original.replace(/@sha256:[0-9a-f]{64}/, '')),
    /digest-pinned/,
  );
  assert.throws(
    () =>
      validateContainerfile(
        original.replace(
          NODE_BASE_REFERENCE,
          NODE_BASE_REFERENCE.replace(/.$/, NODE_BASE_REFERENCE.endsWith('0') ? '1' : '0'),
        ),
      ),
    /exact Node base/,
  );
  assert.throws(
    () => validateContainerfile(`# syntax=docker/dockerfile:1.7\n${original}`),
    /syntax frontend must be digest-pinned/,
  );
  assert.throws(
    () => validateContainerfile(original.replace(DEBIAN_SNAPSHOT, '20250612T000000Z')),
    /exact Debian snapshot/,
  );
  for (const [current, replacement, expectedFinding] of [
    [FFMPEG_PACKAGE_VERSION, '7:5.1.6-0+deb12u2', /exact ffmpeg package/],
    [IMAGEMAGICK_PACKAGE_VERSION, '8:6.9.11.60+dfsg-1.6+deb12u4', /exact ImageMagick package/],
    [TINI_PACKAGE_VERSION, '0.19.0-2', /exact tini package/],
    [MIGRATION_012_SHA256, '0'.repeat(64), /migration 012 checksum/],
  ]) {
    assert.throws(
      () => validateContainerfile(original.replace(current, replacement)),
      expectedFinding,
    );
  }
  assert.throws(
    () => validateContainerfile(original.replace('USER node', 'USER root')),
    /final USER is root/,
  );
  assert.throws(
    () => validateContainerfile(original.replace('USER node', '')),
    /final non-root USER/,
  );
  assert.throws(() => validateContainerfile(`${original}\nCOPY . .\n`), /broad COPY/);
  assert.throws(
    () => validateContainerfile(`${original}\nENV PRODUCTION_PASSWORD=actual-secret-value-123\n`),
    /secret-bearing ARG\/ENV/,
  );
});

test('safe workflow accepts read-only permissions, exact false inputs and pinned actions', () => {
  validateWorkflowObject(safeWorkflow(), safeWorkflowText());
});

test('workflow validator rejects writes, mutable actions, unsafe interpolation and mutation commands', () => {
  const write = safeWorkflow();
  write.permissions.contents = 'write';
  assert.throws(() => validateWorkflowObject(write, safeWorkflowText()), /read-only/);

  const action = safeWorkflow();
  action.jobs.validate.steps[0].uses = 'actions/checkout@v4';
  assert.throws(() => validateWorkflowObject(action, safeWorkflowText()), /full action commit/);

  const interpolation = safeWorkflow();
  interpolation.jobs.validate.steps[1].run = 'echo ${{ github.sha }}';
  assert.throws(() => validateWorkflowObject(interpolation, safeWorkflowText()), /step env map/);

  const mutation = safeWorkflow();
  assert.throws(
    () =>
      validateWorkflowObject(mutation, `${safeWorkflowText()}\ndocker push example.invalid/image`),
    /registry push/,
  );
});

test('workflow validator rejects artifact uploads and false uploaded-artifact claims', () => {
  const workflow = safeWorkflow();
  assert.throws(
    () =>
      validateWorkflowObject(
        workflow,
        `${safeWorkflowText()}\nactions/upload-artifact@${'a'.repeat(40)}`,
      ),
    /artifact publication/,
  );
  assert.throws(
    () => validateWorkflowObject(workflow, `${safeWorkflowText()}\nUploaded artifact`),
    /uploaded-artifact summary claim/,
  );
  assert.throws(
    () => validateWorkflowObject(workflow, `${safeWorkflowText()}\noras push registry.invalid/x`),
    /external artifact publication/,
  );
});

test('workflow validator rejects unsafe dispatch defaults and secret consumption', () => {
  const workflow = safeWorkflow();
  workflow.on.workflow_dispatch.inputs.deploy.default = true;
  assert.throws(() => validateWorkflowObject(workflow, safeWorkflowText()), /default false/);
  assert.throws(
    () =>
      validateWorkflowObject(safeWorkflow(), `${safeWorkflowText()}\n\${{ secrets.DEPLOY_TOKEN }}`),
    /secret consumption/,
  );
});

test('workflow YAML parser rejects duplicate mapping keys', async () => {
  await assert.rejects(
    () => loadYamlWorkflow('name: first\nname: second\non:\n  workflow_dispatch: {}\n'),
    /malformed YAML.*duplicated mapping key/i,
  );
});

test('duplicate JSON object keys are detected at every nesting level', async () => {
  assert.deepEqual(findDuplicateJsonKeys('{"a":1,"nested":{"x":1,"x":2},"a":3}'), [
    '$.nested.x',
    '$.a',
  ]);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinetra-release-json-'));
  await writeFile(path.join(directory, 'duplicate.json'), '{"a":1,"a":2}\n');
  await assert.rejects(
    () => readSafeJson(directory, 'duplicate.json'),
    /duplicate JSON object keys/,
  );
});

test('safe readers reject malformed, oversized, symlink and traversal inputs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kinetra-release-input-'));
  await writeFile(path.join(directory, 'bad.json'), '{');
  await writeFile(path.join(directory, 'large.json'), 'x'.repeat(65));
  await writeFile(path.join(directory, 'target.json'), '{}');
  await symlink('target.json', path.join(directory, 'link.json'));
  await assert.rejects(() => readSafeJson(directory, 'bad.json'), /malformed JSON/);
  await assert.rejects(() => readSafeText(directory, 'large.json', { maxBytes: 64 }), /exceeds/);
  await assert.rejects(() => readSafeText(directory, 'link.json'), /symbolic link/);
  await assert.rejects(() => readSafeText(directory, '../outside.json'), /traverse/);
  await assert.rejects(() => readSafeText(directory, '/etc/passwd'), /relative path/);
});

test('missing environment tools report BLOCKED_BY_ENVIRONMENT and never PASS', () => {
  const report = buildEnvironmentReport({
    probe: () => ({ available: false, detail: 'ENOENT' }),
  });
  assert.equal(report.status, 'BLOCKED_BY_ENVIRONMENT');
  assert.ok(report.blocked.includes('docker'));
  for (const tool of ['syft', 'cosign', 'gitleaks', 'trivy']) {
    assert.ok(report.blocked.includes(tool), `${tool} absence must be reported`);
  }
  assert.equal(JSON.stringify(report).includes('PASS'), false);
});

test('runtime configuration rejects root and missing users plus embedded secret env', () => {
  const base = runtimeInspect();
  const expectedRelease = { releaseCommit, releaseTree };
  assert.deepEqual(inspectRuntimeConfiguration(base, expectedRelease), []);
  const root = structuredClone(base);
  root.Config.User = '0';
  assert.ok(
    inspectRuntimeConfiguration(root, expectedRelease).some((finding) => finding.includes('root')),
  );
  const missing = structuredClone(base);
  missing.Config.User = '';
  assert.ok(
    inspectRuntimeConfiguration(missing, expectedRelease).some((finding) =>
      finding.includes('missing'),
    ),
  );
  const secret = structuredClone(base);
  secret.Config.Env.push('DATABASE_PASSWORD=not-for-an-image');
  assert.ok(
    inspectRuntimeConfiguration(secret, expectedRelease).some((finding) =>
      finding.includes('secret-bearing'),
    ),
  );
  const wrongRelease = structuredClone(base);
  wrongRelease.Config.Labels['io.kinetra.release-definition-tree'] = '3'.repeat(40);
  assert.ok(
    inspectRuntimeConfiguration(wrongRelease, expectedRelease).some((finding) =>
      finding.includes('release definition tree label mismatch'),
    ),
  );
  const wrongMigration = structuredClone(base);
  wrongMigration.Config.Labels['io.kinetra.migration-012.sha256'] = '0'.repeat(64);
  assert.ok(
    inspectRuntimeConfiguration(wrongMigration, expectedRelease).some((finding) =>
      finding.includes('migration 012 checksum'),
    ),
  );
});

test('runtime validator requires exact release labels and exact runtime package versions', async () => {
  const passing = await validateContainerRuntime(digest, {
    docker: successfulRuntimeDocker(),
    releaseCommit,
    releaseTree,
  });
  assert.equal(passing.status, 'PASS');

  for (const [probeKey, invalidOutput, expectedProbe] of [
    ['/usr/local/bin/node', 'v22.16.1\n', 'node'],
    ['/usr/bin/ffmpeg', 'ffmpeg version 5.1.7 Copyright\n', 'ffmpeg'],
    ['/usr/bin/ffprobe', 'ffprobe version 5.1.7 Copyright\n', 'ffprobe'],
    ['/usr/bin/identify', 'Version: ImageMagick 7.1.0 Q16\n', 'imagemagick-identify'],
    ['/usr/bin/convert', 'Version: ImageMagick 7.1.0 Q16\n', 'imagemagick-convert'],
    ['/usr/bin/tini', 'tini version 0.20.0\n', 'tini'],
    ['dpkg-query:ffmpeg', '7:5.1.6-0+deb12u2\n', 'ffmpeg-package'],
    ['dpkg-query:imagemagick', '8:6.9.11.60+dfsg-1.6+deb12u4\n', 'imagemagick-package'],
    ['dpkg-query:tini', '0.19.0-2\n', 'tini-package'],
  ]) {
    const report = await validateContainerRuntime(digest, {
      docker: successfulRuntimeDocker({ [probeKey]: invalidOutput }),
      releaseCommit,
      releaseTree,
    });
    assert.equal(report.status, 'FAIL');
    assert.equal(report.probes[expectedProbe].status, 'FAIL');
  }
});

test('unavailable Docker runtime is BLOCKED_BY_ENVIRONMENT and never a synthetic PASS', async () => {
  const report = await validateContainerRuntime(digest, {
    docker: () => ({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } }),
    releaseCommit,
    releaseTree,
  });
  assert.equal(report.status, 'BLOCKED_BY_ENVIRONMENT');
  assert.equal(JSON.stringify(report).includes('PASS'), false);
});
