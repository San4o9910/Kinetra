import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { config as loadEnv } from 'dotenv';

import {
  assertLocalDemoDatabase,
  defaultLocalDatabaseUrl,
  LOCAL_DEMO_CONFIRMATION,
} from './local-demo-guard.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
loadEnv({ path: resolve(repositoryRoot, '.env'), quiet: true });

const databaseUrl = process.env.DATABASE_URL ?? defaultLocalDatabaseUrl;
assertLocalDemoDatabase({
  databaseUrl,
  nodeEnvironment: process.env.NODE_ENV,
  confirmation: LOCAL_DEMO_CONFIRMATION,
});

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npmCommand, ['run', 'dev'], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: '3000',
    CORS_ORIGIN: 'http://localhost:5173',
    VITE_API_URL: 'http://localhost:3000',
    VITE_PRIVATE_MEDIA_ORIGIN: '',
    AUTH_TOKEN_DELIVERY_MODE: 'console',
    S3_ENDPOINT: '',
    S3_REGION: '',
    S3_BUCKET: '',
    S3_ACCESS_KEY_ID: '',
    S3_SECRET_ACCESS_KEY: '',
    TRAINER_VIDEO_UPLOADS_ENABLED: 'false',
    CHAT_ENABLED: 'true',
    CHAT_PHOTO_UPLOADS_ENABLED: 'false',
    YUKASSA_SHOP_ID: '',
    YUKASSA_SECRET_KEY: '',
    VAPID_PUBLIC_KEY: '',
    VAPID_PRIVATE_KEY: '',
    VAPID_SUBJECT: '',
  },
  stdio: 'inherit',
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.once('SIGINT', () => forwardSignal('SIGINT'));
process.once('SIGTERM', () => forwardSignal('SIGTERM'));

child.once('error', (error) => {
  throw error;
});

child.once('exit', (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});
