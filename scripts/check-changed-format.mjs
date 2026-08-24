import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, getFileInfo, resolveConfig } from 'prettier';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changedPaths = new Set();

const runGit = (arguments_) => {
  const result = spawnSync('git', arguments_, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.toString('utf8').trim() || `git ${arguments_.join(' ')} failed.`);
  }

  return result.stdout;
};

const gitRefExists = (reference) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', reference], {
    cwd: root,
    stdio: 'ignore',
  }).status === 0;

const addNullDelimitedPaths = (buffer) => {
  for (const value of buffer.toString('utf8').split('\0')) {
    if (value.length > 0) changedPaths.add(value);
  }
};

const addDiff = (range = null) => {
  const arguments_ = ['diff', '--name-only', '--diff-filter=ACMRTUXB', '-z'];
  if (range !== null) arguments_.push(range);
  addNullDelimitedPaths(runGit(arguments_));
};

const addCommittedRange = async () => {
  const githubBaseRef = process.env.GITHUB_BASE_REF?.trim();
  if (githubBaseRef !== undefined && githubBaseRef.length > 0) {
    const reference = `refs/remotes/origin/${githubBaseRef}`;
    if (!gitRefExists(reference)) {
      throw new Error(
        `GitHub base ref ${reference} is unavailable; checkout must use fetch-depth 0.`,
      );
    }
    addDiff(`${reference}...HEAD`);
    return;
  }

  const githubEventPath = process.env.GITHUB_EVENT_PATH?.trim();
  if (githubEventPath !== undefined && githubEventPath.length > 0) {
    const event = JSON.parse(await readFile(githubEventPath, 'utf8'));
    const before = typeof event.before === 'string' ? event.before : '';
    if (!/^[0-9a-f]{40}$/u.test(before) || /^0+$/u.test(before)) {
      throw new Error('GitHub push event has no usable before commit; refusing a zero-file check.');
    }
    if (!gitRefExists(`${before}^{commit}`)) {
      throw new Error(
        `GitHub push base ${before} is unavailable; checkout must use fetch-depth 0.`,
      );
    }
    addDiff(`${before}..HEAD`);
    return;
  }

  if (process.env.GITHUB_ACTIONS === 'true') {
    throw new Error('GitHub Actions formatting requires a resolved pull-request or push base.');
  }

  const branch = runGit(['branch', '--show-current']).toString('utf8').trim();
  if (!['main', 'develop'].includes(branch) && gitRefExists('refs/remotes/origin/develop')) {
    addDiff('refs/remotes/origin/develop...HEAD');
  }
};

await addCommittedRange();
addDiff();
addNullDelimitedPaths(runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMRTUXB', '-z']));
addNullDelimitedPaths(runGit(['ls-files', '--others', '--exclude-standard', '-z']));

const failures = [];
let checkedCount = 0;

for (const relativePath of [...changedPaths].sort((left, right) =>
  left.localeCompare(right, 'en'),
)) {
  const absolutePath = path.resolve(root, relativePath);
  const fileInfo = await getFileInfo(absolutePath, {
    ignorePath: path.resolve(root, '.prettierignore'),
  });
  if (fileInfo.ignored || fileInfo.inferredParser === null) continue;

  checkedCount += 1;
  const source = await readFile(absolutePath, 'utf8');
  const configuration = (await resolveConfig(absolutePath, { editorconfig: true })) ?? {};
  if (!(await check(source, { ...configuration, filepath: absolutePath }))) {
    failures.push(relativePath);
  }
}

if (failures.length > 0) {
  console.error('Prettier formatting failed for changed files:');
  for (const relativePath of failures) console.error(`- ${relativePath}`);
  process.exitCode = 1;
} else {
  console.log(`Prettier formatting passed for ${checkedCount} changed file(s).`);
}
