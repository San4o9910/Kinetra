import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Production obtains only explicitly supplied process environment, never a local .env.
if (process.env.NODE_ENV !== 'production') {
  loadEnv({
    path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', '.env'),
    quiet: true,
  });
}

export type NodeEnvironment = 'development' | 'test' | 'production';

export const parseNodeEnvironment = (value: string | undefined): NodeEnvironment => {
  const normalized = value ?? 'development';
  if (!['development', 'test', 'production'].includes(normalized)) {
    throw new Error('NODE_ENV must be development, test or production.');
  }
  return normalized as NodeEnvironment;
};

export const parseDatabaseUrl = (
  nodeEnv: NodeEnvironment,
  rawValue: string | undefined,
): string => {
  const value =
    rawValue ??
    (nodeEnv === 'production'
      ? ''
      : 'postgresql://kinetra:kinetra_local_only@localhost:5432/kinetra');
  if (value.trim() !== value)
    throw new Error('DATABASE_URL must not contain surrounding whitespace.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be an explicit PostgreSQL URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length <= 1 ||
    url.hash
  ) {
    throw new Error('DATABASE_URL must specify a PostgreSQL host and database.');
  }
  if (nodeEnv === 'production') {
    let normalizedHost: string;
    try {
      normalizedHost = new URL(`http://${url.hostname}`).hostname;
    } catch {
      throw new Error('DATABASE_URL host is invalid.');
    }
    const host = normalizedHost
      .replace(/^\[|\]$/gu, '')
      .replace(/\.$/u, '')
      .toLowerCase();
    let password: string;
    let username: string;
    try {
      password = decodeURIComponent(url.password);
      username = decodeURIComponent(url.username);
    } catch {
      throw new Error('DATABASE_URL credentials are invalid.');
    }
    if (
      !username.trim() ||
      !password.trim() ||
      password === 'kinetra_local_only' ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      /^127\./u.test(host) ||
      /^::ffff:7f[0-9a-f]{2}:/u.test(host) ||
      ['::1', '::', '0.0.0.0', '::ffff:0:0'].includes(host)
    ) {
      throw new Error(
        'DATABASE_URL production requires non-local host and non-default credentials.',
      );
    }
    const modes = url.searchParams.getAll('sslmode');
    if (
      modes.length !== 1 ||
      !['require', 'verify-full'].includes(modes[0] ?? '') ||
      [...url.searchParams.keys()].some((key) => !['sslmode', 'application_name'].includes(key))
    ) {
      throw new Error(
        'DATABASE_URL production requires exactly one sslmode=require or verify-full; only application_name is also permitted.',
      );
    }
  }
  return value;
};

export const safeDatabaseErrorCode = (error: unknown): string => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : 'UNCLASSIFIED';
};
