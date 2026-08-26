import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  APP_SOURCE_COMMIT,
  ReleaseContractError,
  findSecretMaterial,
  readSafeJson,
  readSafeText,
  validateArtifactIdentity,
  validateContainerfile,
  validateContractSchema,
  validateRenderedRuntimeUnit,
  validateRollbackTemplate,
  validateRuntimeUnitTemplate,
  validateWorkflowObject,
} from './contracts.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');

const schemaFiles = Object.freeze([
  ['artifact-identity', 'release/contracts/artifact-identity.schema.json'],
  ['runtime-unit', 'release/contracts/runtime-unit.schema.json'],
  ['rollback', 'release/contracts/rollback.schema.json'],
]);
const runtimeTemplates = Object.freeze([
  'release/templates/api.runtime.template.json',
  'release/templates/video-verifier.runtime.template.json',
  'release/templates/video-cleanup.runtime.template.json',
]);

function parseArguments(argv) {
  const result = { rendered: null, metadata: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--rendered' && argument !== '--metadata') {
      throw new ReleaseContractError(`Unknown argument: ${argument}`);
    }
    const key = argument.slice(2);
    if (result[key] !== null)
      throw new ReleaseContractError(`${argument} may be specified only once`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new ReleaseContractError(`${argument} requires a repository-relative JSON path`);
    }
    result[key] = value;
    index += 1;
  }
  if (result.rendered !== null && result.metadata !== null) {
    throw new ReleaseContractError('--rendered and --metadata are mutually exclusive');
  }
  return result;
}

function verifyStrictObjectSchemas(value, location, findings) {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      verifyStrictObjectSchemas(entry, `${location}[${index}]`, findings);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (value.type === 'object' && value.additionalProperties !== false) {
    findings.push(`${location} object schema must set additionalProperties: false`);
  }
  for (const [key, entry] of Object.entries(value)) {
    verifyStrictObjectSchemas(entry, `${location}.${key}`, findings);
  }
}

function collectRunBlocks(workflow) {
  const blocks = [];
  if (workflow?.jobs === null || typeof workflow?.jobs !== 'object') return blocks;
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!Array.isArray(job?.steps)) continue;
    for (const [index, step] of job.steps.entries()) {
      if (typeof step?.run === 'string') {
        blocks.push({ location: `jobs.${jobName}.steps[${index}].run`, script: step.run });
      }
    }
  }
  return blocks;
}

function validateBashSyntax(workflow) {
  const findings = [];
  const blocked = [];
  for (const block of collectRunBlocks(workflow)) {
    const result = spawnSync('bash', ['-n'], {
      input: block.script,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    if (result.error?.code === 'ENOENT') {
      blocked.push('bash is unavailable; workflow run-block syntax could not be checked');
      break;
    }
    if (result.error) {
      findings.push(`${block.location}: bash validation failed: ${result.error.message}`);
      continue;
    }
    if (result.status !== 0) {
      findings.push(
        `${block.location}: ${result.stderr.trim() || `bash -n exited ${result.status}`}`,
      );
    }
  }
  return { findings, blocked };
}

function gitLines(arguments_) {
  const result = spawnSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
  });
  if (result.error?.code === 'ENOENT') {
    return { lines: [], blocked: ['git is unavailable; source-scope allowlist was not checked'] };
  }
  if (result.error || result.status !== 0) {
    throw new ReleaseContractError(
      `git ${arguments_.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return { lines: result.stdout.split(/\r?\n/).filter(Boolean), blocked: [] };
}

function sourcePathAllowed(file) {
  const exact = new Set([
    '.dockerignore',
    '.gitignore',
    '.github/workflows/ci.yml',
    '.github/workflows/release-foundation.yml',
    'Containerfile',
    'MANIFEST.sha256',
    'README.md',
    'VALIDATION.md',
    'package.json',
    'package-lock.json',
    'scripts/verify-project.mjs',
  ]);
  return (
    exact.has(file) ||
    file.startsWith('docs/release/') ||
    file.startsWith('release/contracts/') ||
    file.startsWith('release/templates/') ||
    file.startsWith('scripts/release/')
  );
}

function validateSourceScope() {
  const findings = [];
  const blocked = [];
  const queries = [
    ['diff', '--name-only', `${APP_SOURCE_COMMIT}...HEAD`, '--'],
    ['diff', '--name-only', APP_SOURCE_COMMIT, '--'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  const changed = new Set();
  for (const query of queries) {
    const result = gitLines(query);
    result.lines.forEach((file) => changed.add(file));
    blocked.push(...result.blocked);
  }
  if (blocked.length === 0) {
    for (const file of [...changed].sort()) {
      if (!sourcePathAllowed(file))
        findings.push(`application source change is outside release allowlist: ${file}`);
    }
    const deletions = gitLines(['diff', '--diff-filter=D', '--name-only', APP_SOURCE_COMMIT, '--']);
    blocked.push(...deletions.blocked);
    for (const file of deletions.lines) findings.push(`release definition must not delete ${file}`);
  }
  return { findings, blocked, changed: [...changed].sort() };
}

export async function loadYamlWorkflow(rawText) {
  let yaml;
  try {
    yaml = await import('js-yaml');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      return {
        workflow: null,
        blocked: ['js-yaml is unavailable; workflow YAML was not parsed'],
      };
    }
    throw error;
  }

  try {
    return {
      workflow: yaml.load(rawText, { json: false }),
      blocked: [],
    };
  } catch (error) {
    throw new ReleaseContractError(`release workflow is malformed YAML: ${error.message}`);
  }
}

async function validateStaticArchitecture() {
  const findings = [];
  const blocked = [];

  const sourceScope = validateSourceScope();
  findings.push(...sourceScope.findings);
  blocked.push(...sourceScope.blocked);

  for (const [kind, file] of schemaFiles) {
    const schema = await readSafeJson(repositoryRoot, file);
    validateContractSchema(schema, kind);
    const strictFindings = [];
    verifyStrictObjectSchemas(schema, file, strictFindings);
    findings.push(...strictFindings);
  }

  for (const file of runtimeTemplates) {
    const template = await readSafeJson(repositoryRoot, file);
    validateRuntimeUnitTemplate(template);
    for (const secret of findSecretMaterial(JSON.stringify(template))) {
      findings.push(`${file} contains ${secret}`);
    }
  }
  validateRollbackTemplate(
    await readSafeJson(repositoryRoot, 'release/templates/rollback.runtime.template.json'),
  );

  const containerfile = await readSafeText(repositoryRoot, 'Containerfile');
  validateContainerfile(containerfile);

  const workflowText = await readSafeText(
    repositoryRoot,
    '.github/workflows/release-foundation.yml',
  );
  const loaded = await loadYamlWorkflow(workflowText);
  blocked.push(...loaded.blocked);
  if (loaded.workflow !== null) {
    validateWorkflowObject(loaded.workflow, workflowText);
    const shell = validateBashSyntax(loaded.workflow);
    findings.push(...shell.findings);
    blocked.push(...shell.blocked);
  }

  if (findings.length > 0) {
    throw new ReleaseContractError('Release architecture validation failed', findings);
  }
  return { blocked };
}

function printReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export async function runReleaseArchitectureValidation(argv = process.argv.slice(2)) {
  const arguments_ = parseArguments(argv);
  if (arguments_.rendered !== null) {
    validateRenderedRuntimeUnit(await readSafeJson(repositoryRoot, arguments_.rendered));
    return {
      status: 'PASS',
      scope: 'rendered-runtime-unit',
      file: arguments_.rendered,
    };
  }
  if (arguments_.metadata !== null) {
    validateArtifactIdentity(await readSafeJson(repositoryRoot, arguments_.metadata));
    return {
      status: 'PASS',
      scope: 'artifact-identity',
      file: arguments_.metadata,
    };
  }

  const result = await validateStaticArchitecture();
  if (result.blocked.length > 0) {
    return {
      status: 'BLOCKED_BY_ENVIRONMENT',
      scope: 'static-release-architecture',
      blocked: result.blocked,
    };
  }
  return {
    status: 'PASS',
    scope: 'static-release-architecture',
    validated: {
      schemas: schemaFiles.length,
      runtimeTemplates: runtimeTemplates.length,
      rollbackTemplates: 1,
      containerfiles: 1,
      workflows: 1,
    },
  };
}

async function main() {
  try {
    const report = await runReleaseArchitectureValidation();
    printReport(report);
    process.exitCode = report.status === 'BLOCKED_BY_ENVIRONMENT' ? 2 : 0;
  } catch (error) {
    printReport({
      status: 'FAIL',
      scope: 'release-architecture',
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await main();
