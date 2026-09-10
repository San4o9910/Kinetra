import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';

import {
  assertLocalDemoDatabase,
  createNpmInvocation,
  defaultLocalDatabaseUrl,
  LOCAL_DEMO_CONFIRMATION,
  parseDemoClientEmail,
} from './local-demo-guard.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true });

const demoTrainerEmail = 'trainer.demo@kinetra.local';
const forwardedArguments = process.argv.slice(2);
parseDemoClientEmail(forwardedArguments, demoTrainerEmail);

const databaseUrl = process.env.DATABASE_URL ?? defaultLocalDatabaseUrl;
assertLocalDemoDatabase({
  databaseUrl,
  nodeEnvironment: process.env.NODE_ENV,
  confirmation: LOCAL_DEMO_CONFIRMATION,
});

const childEnvironment = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  KINETRA_LOCAL_DEMO_CONFIRMATION: LOCAL_DEMO_CONFIRMATION,
};

const run = (command, arguments_) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: childEnvironment,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${command} stopped by signal ${signal}.`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`${command} exited with code ${String(code)}.`));
        return;
      }

      resolve();
    });
  });

const runNpm = (arguments_) => {
  const invocation = createNpmInvocation(arguments_);
  return run(invocation.command, invocation.arguments);
};

await runNpm(['run', 'db:migrate']);
await runNpm(['run', 'db:seed']);
await run(process.execPath, ['apps/backend/scripts/seed-local-demo.mjs', ...forwardedArguments]);
