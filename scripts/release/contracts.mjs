import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const APP_SOURCE_COMMIT = 'c5645a3aa84bbc81e688c97731e48d978a2aeb92';
export const APP_SOURCE_TREE = '4ee94cb5d334e54e5996d42caed35e0b3c776a23';
export const NODE_BASE_REFERENCE =
  'node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34';
export const NODE_RUNTIME_VERSION = 'v22.16.0';
export const DEBIAN_SNAPSHOT = '20250611T000000Z';
export const FFMPEG_PACKAGE_VERSION = '7:5.1.6-0+deb12u1';
export const FFMPEG_BINARY_VERSION = '5.1.6-0+deb12u1';
export const IMAGEMAGICK_PACKAGE_VERSION = '8:6.9.11.60+dfsg-1.6+deb12u3';
export const IMAGEMAGICK_BINARY_VERSION = '6.9.11-60';
export const TINI_PACKAGE_VERSION = '0.19.0-1';
export const TINI_BINARY_VERSION = '0.19.0';
export const MIGRATION_012_SHA256 =
  'c05550d0bd3dca13b6cf4a4254c677c4348999bcef3b6f9eb8d8ad76df9de7f4';
export const MAX_VALIDATION_FILE_BYTES = 1024 * 1024;
export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const GENERATED = 'GENERATED_AT_RUNTIME';
const TEMPLATE_ARTIFACT_REFERENCE = '${ARTIFACT_REPOSITORY}@${ARTIFACT_DIGEST}';
const TEMPLATE_ROLLBACK_REFERENCE = '${ROLLBACK_ARTIFACT_REPOSITORY}@${ROLLBACK_ARTIFACT_DIGEST}';

const ROLE_DEFINITIONS = Object.freeze({
  api: {
    name: 'kinetra-api',
    command: ['node', 'apps/backend/dist/server.js'],
    requiredExecutables: ['node', 'ffprobe', 'identify', 'convert'],
    secrets: [
      'DATABASE_URL',
      'JWT_ACCESS_SECRET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'YUKASSA_SECRET_KEY',
      'VAPID_PRIVATE_KEY',
    ],
    health: {
      liveness: {
        type: 'http',
        path: '/health',
        classification: 'PROCESS_LIVENESS_ONLY',
      },
      readiness: {
        status: 'PLATFORM_ADAPTER_REQUIRED',
        classification: 'DO_NOT_TREAT_LIVENESS_AS_DEPENDENCY_READINESS',
      },
    },
  },
  'video-verifier': {
    name: 'kinetra-video-verifier',
    command: ['node', 'apps/backend/dist/video-admin/run-upload-worker.js'],
    requiredExecutables: ['node', 'ffprobe'],
    secrets: [
      'DATABASE_URL',
      'JWT_ACCESS_SECRET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'YUKASSA_SECRET_KEY',
      'VAPID_PRIVATE_KEY',
    ],
    health: {
      liveness: {
        type: 'one-shot-exit-status',
        deadline: '${VERIFIER_DEADLINE}',
      },
      readiness: {
        type: 'database-heartbeat',
        workerName: 'upload_verifier',
        status: 'PLATFORM_ADAPTER_REQUIRED',
      },
    },
  },
  'video-cleanup': {
    name: 'kinetra-video-cleanup',
    command: ['node', 'apps/backend/dist/video-admin/run-media-cleanup.js'],
    requiredExecutables: ['node'],
    secrets: [
      'DATABASE_URL',
      'JWT_ACCESS_SECRET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'YUKASSA_SECRET_KEY',
      'VAPID_PRIVATE_KEY',
    ],
    health: {
      liveness: {
        type: 'one-shot-exit-status',
        deadline: '${CLEANUP_DEADLINE}',
      },
      readiness: {
        type: 'database-heartbeat',
        workerName: 'media_cleanup',
        status: 'PLATFORM_ADAPTER_REQUIRED',
      },
    },
  },
});

const RUNTIME_TOP_KEYS = ['apiVersion', 'kind', 'metadata', 'spec'];
const RUNTIME_METADATA_KEYS = ['name', 'sourceCommit', 'sourceTree', 'templateStatus'];
const RUNTIME_SPEC_KEYS = [
  'role',
  'artifactReference',
  'artifactDigest',
  'command',
  'requiredExecutables',
  'environment',
  'security',
  'health',
  'resources',
  'rollbackReference',
  'deploymentAllowed',
  'migrationAllowed',
  'featureFlagActivationAllowed',
];

export class ReleaseContractError extends Error {
  constructor(message, findings = []) {
    super(findings.length === 0 ? message : `${message}:\n- ${findings.join('\n- ')}`);
    this.name = 'ReleaseContractError';
    this.findings = findings;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, location, findings) {
  if (!isObject(value)) {
    findings.push(`${location} must be an object`);
    return false;
  }

  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    findings.push(
      `${location} keys must be exactly [${wanted.join(', ')}], got [${actual.join(', ')}]`,
    );
    return false;
  }
  return true;
}

function expect(condition, message, findings) {
  if (!condition) findings.push(message);
}

function throwFindings(message, findings) {
  if (findings.length > 0) throw new ReleaseContractError(message, findings);
}

function validateDigestOrGenerated(value, location, findings) {
  expect(
    value === GENERATED || (typeof value === 'string' && SHA256_PATTERN.test(value)),
    `${location} must be ${GENERATED} or a lowercase sha256 digest`,
    findings,
  );
}

export function parseDigestPinnedReference(reference, location = 'artifact reference') {
  if (typeof reference !== 'string' || reference.length === 0) {
    throw new ReleaseContractError(`${location} must be a non-empty string`);
  }
  if (reference.includes('${') || /\s/.test(reference)) {
    throw new ReleaseContractError(`${location} must not contain placeholders or whitespace`);
  }

  const match = /^([^@]+)@(sha256:[0-9a-f]{64})$/.exec(reference);
  if (!match) {
    throw new ReleaseContractError(
      `${location} must be pinned as repository@sha256:<64 lowercase hex characters>`,
    );
  }

  const repository = match[1];
  const lastSlash = repository.lastIndexOf('/');
  if (repository.slice(lastSlash + 1).includes(':')) {
    throw new ReleaseContractError(`${location} must not contain a mutable tag`);
  }
  if (
    repository.startsWith('/') ||
    repository.endsWith('/') ||
    repository.includes('://') ||
    repository.includes('..') ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*[A-Za-z0-9]$/.test(repository)
  ) {
    throw new ReleaseContractError(`${location} contains an invalid repository name`);
  }

  return { repository, digest: match[2] };
}

export function validateArtifactIdentity(value) {
  const findings = [];
  const keys = [
    'contractVersion',
    'sourceCommit',
    'sourceTree',
    'releaseDefinitionCommit',
    'releaseDefinitionTree',
    'artifactReference',
    'artifactDigest',
    'artifactDigestKind',
    'manifestDigest',
    'sbomDigest',
    'provenanceReference',
    'signatureReference',
    'builder',
    'createdAt',
    'publishStatus',
  ];
  if (!exactKeys(value, keys, 'artifact identity', findings)) {
    throwFindings('Invalid artifact identity', findings);
  }

  expect(
    value.contractVersion === 'kinetra.release.artifact-identity/v1',
    'contractVersion is not supported',
    findings,
  );
  expect(value.sourceCommit === APP_SOURCE_COMMIT, 'sourceCommit does not match T14', findings);
  expect(value.sourceTree === APP_SOURCE_TREE, 'sourceTree does not match T14', findings);
  expect(
    typeof value.releaseDefinitionCommit === 'string' &&
      SHA_PATTERN.test(value.releaseDefinitionCommit),
    'releaseDefinitionCommit must be a full lowercase Git commit',
    findings,
  );
  expect(
    typeof value.releaseDefinitionTree === 'string' &&
      SHA_PATTERN.test(value.releaseDefinitionTree),
    'releaseDefinitionTree must be a full lowercase Git tree',
    findings,
  );
  expect(
    value.artifactReference === 'UNPUBLISHED',
    'artifactReference must be UNPUBLISHED',
    findings,
  );
  validateDigestOrGenerated(value.artifactDigest, 'artifactDigest', findings);
  validateDigestOrGenerated(value.manifestDigest, 'manifestDigest', findings);
  validateDigestOrGenerated(value.sbomDigest, 'sbomDigest', findings);
  expect(
    value.artifactDigestKind === 'NOT_GENERATED' ||
      value.artifactDigestKind === 'LOCAL_ARCHIVE_SHA256_NOT_REGISTRY_MANIFEST' ||
      value.artifactDigestKind === 'LOCAL_OCI_MANIFEST_UNPUBLISHED',
    'artifactDigestKind is invalid',
    findings,
  );
  expect(
    (value.artifactDigest === GENERATED && value.artifactDigestKind === 'NOT_GENERATED') ||
      (SHA256_PATTERN.test(value.artifactDigest) &&
        (value.artifactDigestKind === 'LOCAL_ARCHIVE_SHA256_NOT_REGISTRY_MANIFEST' ||
          value.artifactDigestKind === 'LOCAL_OCI_MANIFEST_UNPUBLISHED')),
    'artifactDigest and artifactDigestKind are inconsistent',
    findings,
  );
  expect(
    typeof value.provenanceReference === 'string' &&
      /^LOCAL_UNSIGNED_BUILD_PROVENANCE:sha256:[0-9a-f]{64}$/.test(value.provenanceReference),
    'provenanceReference must bind local unsigned provenance to its SHA-256',
    findings,
  );
  expect(
    value.signatureReference === 'NOT_SIGNED_DRY_RUN',
    'signatureReference must state that the dry run is unsigned',
    findings,
  );
  expect(
    typeof value.builder === 'string' &&
      value.builder.length > 0 &&
      value.builder.length <= 512 &&
      !/[\r\n]/.test(value.builder),
    'builder must be a bounded single-line string',
    findings,
  );
  expect(
    typeof value.createdAt === 'string' &&
      value.createdAt.endsWith('Z') &&
      !Number.isNaN(Date.parse(value.createdAt)),
    'createdAt must be a UTC ISO-8601 timestamp',
    findings,
  );
  expect(value.publishStatus === false, 'publishStatus must remain false', findings);
  throwFindings('Invalid artifact identity', findings);
  return value;
}

function validateRuntime(value, { rendered }) {
  const findings = [];
  if (!exactKeys(value, RUNTIME_TOP_KEYS, 'runtime unit', findings)) {
    throwFindings('Invalid runtime unit', findings);
  }
  expect(value.apiVersion === 'kinetra.release/v1', 'apiVersion is invalid', findings);
  expect(value.kind === 'RuntimeUnitTemplate', 'kind must be RuntimeUnitTemplate', findings);

  if (exactKeys(value.metadata, RUNTIME_METADATA_KEYS, 'metadata', findings)) {
    expect(
      value.metadata.sourceCommit === APP_SOURCE_COMMIT,
      'metadata.sourceCommit mismatch',
      findings,
    );
    expect(value.metadata.sourceTree === APP_SOURCE_TREE, 'metadata.sourceTree mismatch', findings);
    expect(
      value.metadata.templateStatus === 'NON_DEPLOYABLE',
      'metadata.templateStatus must remain NON_DEPLOYABLE',
      findings,
    );
  }

  if (!exactKeys(value.spec, RUNTIME_SPEC_KEYS, 'spec', findings)) {
    throwFindings('Invalid runtime unit', findings);
  }
  const definition = ROLE_DEFINITIONS[value.spec.role];
  expect(Boolean(definition), 'spec.role is invalid', findings);
  if (definition) {
    expect(value.metadata?.name === definition.name, 'metadata.name does not match role', findings);
    expect(
      isDeepStrictEqual(value.spec.command, definition.command),
      'spec.command does not match role',
      findings,
    );
    expect(
      isDeepStrictEqual(value.spec.requiredExecutables, definition.requiredExecutables),
      'spec.requiredExecutables does not match role',
      findings,
    );
  }

  if (rendered) {
    try {
      const artifact = parseDigestPinnedReference(
        value.spec.artifactReference,
        'spec.artifactReference',
      );
      expect(
        value.spec.artifactDigest === artifact.digest,
        'spec.artifactDigest does not match reference',
        findings,
      );
    } catch (error) {
      findings.push(error.message);
    }
    try {
      parseDigestPinnedReference(value.spec.rollbackReference, 'spec.rollbackReference');
    } catch (error) {
      findings.push(error.message);
    }
  } else {
    expect(
      value.spec.artifactReference === TEMPLATE_ARTIFACT_REFERENCE,
      'template artifactReference is invalid',
      findings,
    );
    expect(
      value.spec.artifactDigest === '${ARTIFACT_DIGEST}',
      'template artifactDigest is invalid',
      findings,
    );
    expect(
      value.spec.rollbackReference === TEMPLATE_ROLLBACK_REFERENCE,
      'template rollbackReference is invalid',
      findings,
    );
  }

  if (
    exactKeys(
      value.spec.environment,
      ['literals', 'secretReferences'],
      'spec.environment',
      findings,
    )
  ) {
    if (
      exactKeys(
        value.spec.environment.literals,
        ['NODE_ENV', 'TRAINER_VIDEO_UPLOADS_ENABLED'],
        'spec.environment.literals',
        findings,
      )
    ) {
      expect(
        value.spec.environment.literals.NODE_ENV === 'production',
        'NODE_ENV must be production',
        findings,
      );
      expect(
        value.spec.environment.literals.TRAINER_VIDEO_UPLOADS_ENABLED === 'false',
        'TRAINER_VIDEO_UPLOADS_ENABLED must remain the string false',
        findings,
      );
    }

    const refs = value.spec.environment.secretReferences;
    expect(Array.isArray(refs), 'secretReferences must be an array', findings);
    if (Array.isArray(refs) && definition) {
      const seen = new Set();
      for (const [index, ref] of refs.entries()) {
        if (
          !exactKeys(
            ref,
            ['environmentVariable', 'reference'],
            `secretReferences[${index}]`,
            findings,
          )
        ) {
          continue;
        }
        expect(
          !seen.has(ref.environmentVariable),
          `duplicate secret reference ${ref.environmentVariable}`,
          findings,
        );
        seen.add(ref.environmentVariable);
        const referenceVariable = ref.environmentVariable.endsWith('_SECRET')
          ? `${ref.environmentVariable}_REF`
          : `${ref.environmentVariable}_SECRET_REF`;
        expect(
          ref.reference === `\${${referenceVariable}}`,
          `secret reference ${ref.environmentVariable} must be indirect`,
          findings,
        );
      }
      expect(
        isDeepStrictEqual([...seen].sort(), [...definition.secrets].sort()),
        `secret reference set does not match ${value.spec.role}`,
        findings,
      );
    }
  }

  if (
    exactKeys(
      value.spec.security,
      [
        'runAsNonRoot',
        'runAsUser',
        'readOnlyRootFilesystem',
        'allowPrivilegeEscalation',
        'writablePaths',
      ],
      'spec.security',
      findings,
    )
  ) {
    expect(value.spec.security.runAsNonRoot === true, 'runAsNonRoot must be true', findings);
    expect(
      rendered
        ? Number.isInteger(value.spec.security.runAsUser) && value.spec.security.runAsUser > 0
        : value.spec.security.runAsUser === '${RUNTIME_UID}',
      rendered
        ? 'rendered runAsUser must be a positive numeric UID'
        : 'template runAsUser must be ${RUNTIME_UID}',
      findings,
    );
    expect(
      value.spec.security.readOnlyRootFilesystem === true,
      'readOnlyRootFilesystem must be true',
      findings,
    );
    expect(
      value.spec.security.allowPrivilegeEscalation === false,
      'allowPrivilegeEscalation must be false',
      findings,
    );
    expect(
      isDeepStrictEqual(value.spec.security.writablePaths, ['/tmp']),
      'writablePaths must be exactly [/tmp]',
      findings,
    );
  }

  expect(isObject(value.spec.health), 'spec.health must be an object', findings);
  if (definition && isObject(value.spec.health)) {
    expect(
      isDeepStrictEqual(value.spec.health, definition.health),
      'spec.health does not match role',
      findings,
    );
  }
  if (
    exactKeys(
      value.spec.resources,
      ['status', 'cpuLimit', 'memoryLimit'],
      'spec.resources',
      findings,
    )
  ) {
    expect(
      value.spec.resources.status === 'PLATFORM_ADAPTER_REQUIRED',
      'resources.status must require a platform adapter',
      findings,
    );
    expect(
      value.spec.resources.cpuLimit === '${CPU_LIMIT}',
      'cpuLimit placeholder is invalid',
      findings,
    );
    expect(
      value.spec.resources.memoryLimit === '${MEMORY_LIMIT}',
      'memoryLimit placeholder is invalid',
      findings,
    );
  }
  expect(value.spec.deploymentAllowed === false, 'deploymentAllowed must be false', findings);
  expect(value.spec.migrationAllowed === false, 'migrationAllowed must be false', findings);
  expect(
    value.spec.featureFlagActivationAllowed === false,
    'featureFlagActivationAllowed must be false',
    findings,
  );

  throwFindings('Invalid runtime unit', findings);
  return value;
}

export function validateRuntimeUnitTemplate(value) {
  return validateRuntime(value, { rendered: false });
}

export function validateRenderedRuntimeUnit(value) {
  return validateRuntime(value, { rendered: true });
}

export function validateRollbackTemplate(value) {
  const findings = [];
  const expected = {
    apiVersion: 'kinetra.release/v1',
    kind: 'RollbackTemplate',
    metadata: {
      name: 'kinetra-rollback',
      sourceCommit: APP_SOURCE_COMMIT,
      sourceTree: APP_SOURCE_TREE,
      templateStatus: 'NON_DEPLOYABLE',
    },
    spec: {
      currentArtifactReference: '${CURRENT_ARTIFACT_REPOSITORY}@${CURRENT_ARTIFACT_DIGEST}',
      previousArtifactReference: '${PREVIOUS_ARTIFACT_REPOSITORY}@${PREVIOUS_ARTIFACT_DIGEST}',
      featureFlagTarget: 'false',
      migrationPolicy: 'FORWARD_ONLY_NO_DOWN_MIGRATION',
      cleanupWorkerPolicy: 'CONTINUE',
      verifierWorkerPolicy: 'CONTINUE_PENDING_RECOVERY',
      operation: 'PLATFORM_ADAPTER_REQUIRED',
      propagationVerification: 'PLATFORM_ADAPTER_REQUIRED',
      approvalStatus: 'REQUIRED',
    },
  };
  expect(
    isDeepStrictEqual(value, expected),
    'rollback template differs from the fail-closed contract',
    findings,
  );
  throwFindings('Invalid rollback template', findings);
  return value;
}

export function validateContractSchema(schema, kind) {
  const findings = [];
  expect(isObject(schema), `${kind} schema must be an object`, findings);
  if (isObject(schema)) {
    expect(
      schema.$schema === 'https://json-schema.org/draft/2020-12/schema',
      `${kind} schema must use JSON Schema 2020-12`,
      findings,
    );
    expect(schema.type === 'object', `${kind} schema root must be an object`, findings);
    expect(schema.additionalProperties === false, `${kind} schema root must be strict`, findings);
    expect(
      Array.isArray(schema.required) && schema.required.length > 0,
      `${kind} schema required list missing`,
      findings,
    );
    const serialized = JSON.stringify(schema);
    expect(
      serialized.includes(APP_SOURCE_COMMIT),
      `${kind} schema source commit is not pinned`,
      findings,
    );
    expect(
      serialized.includes(APP_SOURCE_TREE),
      `${kind} schema source tree is not pinned`,
      findings,
    );
    if (kind === 'runtime-unit') {
      expect(
        schema.properties?.metadata?.additionalProperties === false &&
          schema.properties?.spec?.additionalProperties === false,
        'runtime-unit schema nested records must be strict',
        findings,
      );
    }
  }
  throwFindings(`Invalid ${kind} schema`, findings);
  return schema;
}

export function findSecretMaterial(text) {
  const findings = [];
  const patterns = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, 'embedded private key'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
    [/\bgh[opsu]_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
    [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/, 'GitHub fine-grained token'],
    [/\b(?:postgres(?:ql)?|mysql):\/\/[^\s:/]+:[^\s@]+@/i, 'credential-bearing database URL'],
    [
      /\b(?:password|passwd|secret|token|access[_-]?key)\s*[:=]\s*["']?(?!false\b|null\b|\$\{)[A-Za-z0-9/+_.=-]{12,}/i,
      'inline credential-like value',
    ],
  ];
  for (const [pattern, description] of patterns) {
    if (pattern.test(text)) findings.push(description);
  }
  return findings;
}

export function validateContainerfile(text) {
  const findings = [];
  expect(typeof text === 'string' && text.length > 0, 'Containerfile is empty', findings);
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
  const syntaxLines = lines.filter((line) => /^\s*#\s*syntax\s*=/i.test(line));
  expect(
    syntaxLines.length <= 1,
    'Containerfile may declare at most one Dockerfile syntax frontend',
    findings,
  );
  for (const line of syntaxLines) {
    expect(
      /^\s*#\s*syntax\s*=\s*[^@\s]+@sha256:[0-9a-f]{64}\s*$/i.test(line),
      'Containerfile syntax frontend must be digest-pinned or omitted',
      findings,
    );
  }

  const fromLines = lines.filter((line) => /^\s*FROM\s+/i.test(line));
  expect(fromLines.length > 0, 'Containerfile has no FROM instruction', findings);
  const nonScratchImages = [];
  for (const line of fromLines) {
    const token = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line)?.[1];
    if (!token || token.toLowerCase() === 'scratch') continue;
    nonScratchImages.push(token);
    expect(
      !token.includes('$'),
      `FROM must not use an unresolved image variable: ${token}`,
      findings,
    );
    expect(
      /^[^@\s]+@sha256:[0-9a-f]{64}$/.test(token),
      `FROM image must be digest-pinned: ${token}`,
      findings,
    );
  }
  expect(
    nonScratchImages.length === 2 &&
      nonScratchImages.every((image) => image === NODE_BASE_REFERENCE),
    `Containerfile non-scratch stages must use exact Node base ${NODE_BASE_REFERENCE}`,
    findings,
  );

  const exactRuntimeInputs = [
    [`ARG DEBIAN_SNAPSHOT=${DEBIAN_SNAPSHOT}`, 'exact Debian snapshot'],
    [`'ffmpeg=${FFMPEG_PACKAGE_VERSION}'`, 'exact ffmpeg package version'],
    [`'imagemagick=${IMAGEMAGICK_PACKAGE_VERSION}'`, 'exact ImageMagick package version'],
    [`'tini=${TINI_PACKAGE_VERSION}'`, 'exact tini package version'],
    [
      `io.kinetra.migration-012.sha256="${MIGRATION_012_SHA256}"`,
      'exact migration 012 checksum label',
    ],
  ];
  for (const [literal, description] of exactRuntimeInputs) {
    expect(text.includes(literal), `Containerfile must retain ${description}`, findings);
  }

  const userLines = lines.filter((line) => /^\s*USER\s+/i.test(line));
  expect(userLines.length > 0, 'Containerfile must set a final non-root USER', findings);
  const finalUser = userLines
    .at(-1)
    ?.replace(/^\s*USER\s+/i, '')
    .trim()
    .split(/\s+/)[0];
  expect(Boolean(finalUser), 'Containerfile final USER is missing', findings);
  expect(
    !/^(?:0|root)(?::(?:0|root))?$/i.test(finalUser ?? ''),
    'Containerfile final USER is root',
    findings,
  );

  const forbidden = [
    [/^\s*HEALTHCHECK\b/im, 'role-neutral runtime must not define a shared Docker HEALTHCHECK'],
    [/\bCOPY\s+(?:--\S+\s+)*\.\s+\.?\/?\s*$/im, 'broad COPY . is forbidden'],
    [/^\s*ADD\s+https?:\/\//im, 'remote ADD is forbidden'],
    [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b/i, 'download-to-shell is forbidden'],
    [/\bchmod\s+(?:-R\s+)?777\b/i, 'world-writable chmod is forbidden'],
    [/--privileged\b/i, 'privileged runtime option is forbidden'],
    [
      /^\s*(?:ARG|ENV)\s+(?:[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|ACCESS_KEY)[A-Z0-9_]*)\b/im,
      'secret-bearing ARG/ENV is forbidden',
    ],
  ];
  for (const [pattern, description] of forbidden) {
    if (pattern.test(text)) findings.push(description);
  }
  for (const secret of findSecretMaterial(text)) findings.push(`Containerfile contains ${secret}`);

  expect(
    /org\.opencontainers\.image\.revision="\$\{RELEASE_DEFINITION_COMMIT\}"/.test(text) &&
      /io\.kinetra\.release-definition-commit="\$\{RELEASE_DEFINITION_COMMIT\}"/.test(text) &&
      /io\.kinetra\.release-definition-tree="\$\{RELEASE_DEFINITION_TREE\}"/.test(text),
    'Containerfile release-definition identity labels are missing or not build-bound',
    findings,
  );
  expect(
    /io\.kinetra\.app-source-commit="c5645a3aa84bbc81e688c97731e48d978a2aeb92"/.test(text) &&
      /io\.kinetra\.app-source-tree="4ee94cb5d334e54e5996d42caed35e0b3c776a23"/.test(text),
    'Containerfile fixed application source labels are missing or mismatched',
    findings,
  );
  expect(
    /TRAINER_VIDEO_UPLOADS_ENABLED=false\b/.test(text),
    'Containerfile must keep TRAINER_VIDEO_UPLOADS_ENABLED=false',
    findings,
  );
  expect(
    /^\s*ENTRYPOINT\s+\["\/usr\/bin\/tini",\s*"--"\]\s*$/im.test(text),
    'Containerfile must use the expected exec-form tini entrypoint',
    findings,
  );
  expect(
    /^\s*CMD\s+\["node",\s*"apps\/backend\/dist\/server\.js"\]\s*$/im.test(text),
    'Containerfile must use the exact API default command',
    findings,
  );

  throwFindings('Unsafe Containerfile', findings);
  return true;
}

function visitWorkflowSteps(workflow, callback) {
  if (!isObject(workflow?.jobs)) return;
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!isObject(job) || !Array.isArray(job.steps)) continue;
    for (const [index, step] of job.steps.entries()) callback(step, `${jobName}.steps[${index}]`);
  }
}

function validatePermissions(permissions, location, findings) {
  if (!isObject(permissions)) {
    findings.push(`${location} must be an explicit object`);
    return;
  }
  for (const [key, value] of Object.entries(permissions)) {
    expect(
      (key === 'contents' || key === 'actions') && value === 'read',
      `${location}.${key} must not grant more than read-only contents/actions access`,
      findings,
    );
  }
}

export function validateWorkflowObject(workflow, rawText = JSON.stringify(workflow)) {
  const findings = [];
  expect(isObject(workflow), 'workflow must be an object', findings);
  if (!isObject(workflow)) throwFindings('Unsafe release workflow', findings);

  validatePermissions(workflow.permissions, 'permissions', findings);
  expect(
    isObject(workflow.permissions) &&
      workflow.permissions.contents === 'read' &&
      workflow.permissions.actions === 'read' &&
      Object.keys(workflow.permissions).length === 2,
    'top-level permissions must be exactly contents: read and actions: read',
    findings,
  );

  const triggers = workflow.on;
  expect(isObject(triggers), 'workflow.on must be an object', findings);
  if (isObject(triggers)) {
    expect(
      !Object.hasOwn(triggers, 'pull_request_target'),
      'pull_request_target is forbidden',
      findings,
    );
    expect(isObject(triggers.workflow_dispatch), 'workflow_dispatch trigger is required', findings);
    const inputs = triggers.workflow_dispatch?.inputs;
    expect(isObject(inputs), 'workflow_dispatch.inputs is required', findings);
    if (isObject(inputs)) {
      const requiredInputs = ['publish', 'deploy', 'migrate', 'enable_feature_flag'];
      expect(
        isDeepStrictEqual(Object.keys(inputs).sort(), [...requiredInputs].sort()),
        `workflow_dispatch inputs must be exactly ${requiredInputs.join(', ')}`,
        findings,
      );
      for (const name of requiredInputs) {
        const input = inputs[name];
        expect(
          isObject(input) &&
            input.type === 'boolean' &&
            input.default === false &&
            input.required === true,
          `workflow_dispatch input ${name} must be required boolean and default false`,
          findings,
        );
      }
    }
  }

  if (isObject(workflow.jobs)) {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (isObject(job) && Object.hasOwn(job, 'permissions')) {
        validatePermissions(job.permissions, `jobs.${jobName}.permissions`, findings);
      }
      expect(!job?.environment, `jobs.${jobName} must not target an environment`, findings);
    }
  }

  visitWorkflowSteps(workflow, (step, location) => {
    if (!isObject(step)) {
      findings.push(`${location} must be an object`);
      return;
    }
    if (typeof step.uses === 'string') {
      if (step.uses.startsWith('./')) return;
      if (step.uses.startsWith('docker://')) {
        expect(
          /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(step.uses),
          `${location}.uses Docker reference must be digest-pinned`,
          findings,
        );
      } else {
        expect(
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(step.uses),
          `${location}.uses must be pinned to a full action commit`,
          findings,
        );
      }
    }
    if (typeof step.run === 'string') {
      expect(
        !step.run.includes('${{'),
        `${location}.run must receive expressions through a step env map, not inline interpolation`,
        findings,
      );
    }
  });

  const unsafePatterns = [
    [/\bpull_request_target\b/i, 'pull_request_target'],
    [/\$\{\{\s*secrets\./i, 'GitHub secret consumption'],
    [
      /\b(?:packages|id-token|deployments|statuses|security-events)\s*:\s*write\b/i,
      'write permission',
    ],
    [/\bdocker\s+(?:image\s+)?push\b/i, 'container registry push'],
    [/\b(?:docker\s+)?buildx\b[^\n]*--push\b/i, 'buildx push'],
    [
      /\b(?:kubectl\s+(?:apply|create|delete|patch|replace|rollout)|helm\s+(?:install|upgrade|rollback|uninstall))\b/i,
      'deployment mutation',
    ],
    [
      /\b(?:npm\s+run\s+db:migrate|psql\b|prisma\s+migrate|sequelize\s+db:migrate)\b/i,
      'database migration',
    ],
    [
      /\baws\s+s3(?:api)?\s+(?:cp|mv|rm|sync|put-object|delete-object|create-bucket)\b/i,
      'S3 mutation',
    ],
    [
      /\bactions\/(?:upload-artifact|upload-pages-artifact)@[0-9a-f]+\b/i,
      'GitHub Actions artifact publication',
    ],
    [
      /\bgh\s+release\s+(?:create|upload)\b|\bnpm\s+publish\b|\b(?:oras|crane|skopeo)\s+(?:push|copy)\b/i,
      'external artifact publication',
    ],
    [/\bcurl\b[^\n]*(?:--upload-file|-T(?:\s|=))/i, 'HTTP artifact upload'],
    [/\bUploaded artifact\b/i, 'misleading uploaded-artifact summary claim'],
    [/TRAINER_VIDEO_UPLOADS_ENABLED\s*[:=]\s*["']?true\b/i, 'feature flag activation'],
  ];
  for (const [pattern, description] of unsafePatterns) {
    if (pattern.test(rawText)) findings.push(`workflow contains forbidden ${description}`);
  }
  for (const secret of findSecretMaterial(rawText)) findings.push(`workflow contains ${secret}`);

  expect(
    rawText.includes(APP_SOURCE_COMMIT),
    'workflow does not pin the T14 application commit',
    findings,
  );
  expect(
    rawText.includes(APP_SOURCE_TREE),
    'workflow does not pin the T14 application tree',
    findings,
  );
  expect(
    /git rev-parse HEAD(?:\s|["'])/.test(rawText),
    'workflow does not verify the exact Git HEAD',
    findings,
  );
  expect(
    /git rev-parse HEAD\^\{tree\}/.test(rawText),
    'workflow does not verify the exact Git tree',
    findings,
  );
  expect(
    rawText.includes('GITHUB_SHA') || /\$\{\{\s*github\.sha\s*\}\}/.test(rawText),
    'workflow does not bind validation to the dispatched GitHub SHA',
    findings,
  );

  throwFindings('Unsafe release workflow', findings);
  return true;
}

export function normalizeRepoRelative(input, location = 'path') {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new ReleaseContractError(`${location} must be a non-empty relative path`);
  }
  if (path.isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input) || input.includes('\\')) {
    throw new ReleaseContractError(`${location} must be a portable repository-relative path`);
  }
  const normalized = path.posix.normalize(input);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    input.split('/').includes('..')
  ) {
    throw new ReleaseContractError(`${location} must not traverse outside the repository`);
  }
  return normalized;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function readSafeText(
  repositoryRoot,
  input,
  { maxBytes = MAX_VALIDATION_FILE_BYTES } = {},
) {
  const relative = normalizeRepoRelative(input);
  const root = await realpath(repositoryRoot);
  const candidate = path.resolve(root, relative);
  if (!isWithin(root, candidate)) throw new ReleaseContractError('path escapes repository root');

  const stat = await lstat(candidate);
  if (stat.isSymbolicLink())
    throw new ReleaseContractError(`${relative} must not be a symbolic link`);
  if (!stat.isFile()) throw new ReleaseContractError(`${relative} must be a regular file`);
  if (stat.size > maxBytes) {
    throw new ReleaseContractError(`${relative} exceeds the ${maxBytes}-byte validation limit`);
  }
  const resolved = await realpath(candidate);
  if (!isWithin(root, resolved))
    throw new ReleaseContractError(`${relative} resolves outside the repository`);

  const value = await readFile(resolved, 'utf8');
  if (value.includes('\0')) throw new ReleaseContractError(`${relative} contains a NUL byte`);
  return value;
}

export async function readSafeJson(repositoryRoot, input, options) {
  const text = await readSafeText(repositoryRoot, input, options);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ReleaseContractError(`${input} is malformed JSON: ${error.message}`);
  }
  const duplicateKeys = findDuplicateJsonKeys(text);
  if (duplicateKeys.length > 0) {
    throw new ReleaseContractError(
      `${input} contains duplicate JSON object keys: ${duplicateKeys.join(', ')}`,
    );
  }
  return value;
}

export function findDuplicateJsonKeys(text) {
  let offset = 0;
  const duplicates = [];

  const skipWhitespace = () => {
    while (/\s/.test(text[offset] ?? '')) offset += 1;
  };
  const readString = () => {
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === '\\') {
        offset += 2;
      } else if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      } else {
        offset += 1;
      }
    }
    return '';
  };
  const readValue = (location) => {
    skipWhitespace();
    if (text[offset] === '{') {
      offset += 1;
      skipWhitespace();
      const keys = new Set();
      while (offset < text.length && text[offset] !== '}') {
        const key = readString();
        const keyLocation = location === '$' ? `$.${key}` : `${location}.${key}`;
        if (keys.has(key)) duplicates.push(keyLocation);
        keys.add(key);
        skipWhitespace();
        offset += 1;
        readValue(keyLocation);
        skipWhitespace();
        if (text[offset] === ',') {
          offset += 1;
          skipWhitespace();
        } else {
          break;
        }
      }
      offset += 1;
      return;
    }
    if (text[offset] === '[') {
      offset += 1;
      skipWhitespace();
      let index = 0;
      while (offset < text.length && text[offset] !== ']') {
        readValue(`${location}[${index}]`);
        index += 1;
        skipWhitespace();
        if (text[offset] === ',') {
          offset += 1;
          skipWhitespace();
        } else {
          break;
        }
      }
      offset += 1;
      return;
    }
    if (text[offset] === '"') {
      readString();
      return;
    }
    while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset += 1;
  };

  readValue('$');
  return [...new Set(duplicates)];
}

export function runtimeRoleDefinitions() {
  return structuredClone(ROLE_DEFINITIONS);
}
