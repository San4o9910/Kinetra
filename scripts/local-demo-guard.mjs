export const LOCAL_DEMO_CONFIRMATION = 'kinetra-local-demo-only';

export const defaultLocalDatabaseUrl =
  'postgresql://kinetra:kinetra_local_only@localhost:5432/kinetra';

const localDatabaseHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const refuse = (message) => {
  throw new Error(`LOCAL_DEMO_REFUSED: ${message}`);
};

export const assertLocalDemoDatabase = ({ databaseUrl, nodeEnvironment, confirmation }) => {
  if (nodeEnvironment !== 'development') {
    refuse('NODE_ENV must be exactly development.');
  }

  if (confirmation !== LOCAL_DEMO_CONFIRMATION) {
    refuse('the local-demo safety confirmation is missing.');
  }

  let parsed;

  try {
    parsed = new URL(databaseUrl);
  } catch {
    refuse('DATABASE_URL is not a valid URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    refuse('only PostgreSQL is supported.');
  }

  if (!localDatabaseHosts.has(parsed.hostname)) {
    refuse(`database host ${parsed.hostname} is not local.`);
  }

  if (parsed.port !== '' && parsed.port !== '5432') {
    refuse('the local demo database must use PostgreSQL port 5432.');
  }

  if (
    decodeURIComponent(parsed.username) !== 'kinetra' ||
    decodeURIComponent(parsed.password) !== 'kinetra_local_only' ||
    decodeURIComponent(parsed.pathname) !== '/kinetra'
  ) {
    refuse('DATABASE_URL must identify the dedicated local kinetra database.');
  }

  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    refuse('DATABASE_URL must not contain query parameters or fragments.');
  }

  return parsed;
};

export const parseDemoClientEmail = (arguments_, reservedTrainerEmail) => {
  if (arguments_.length !== 2 || arguments_[0] !== '--email') {
    refuse('use --email <your-local-account-email>.');
  }

  const email = arguments_[1]?.normalize('NFC').trim().toLowerCase() ?? '';

  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    refuse('the client email is invalid.');
  }

  if (email === reservedTrainerEmail) {
    refuse('the client and demo trainer must be different accounts.');
  }

  return email;
};

export const createNpmInvocation = (
  arguments_,
  {
    platform = process.platform,
    nodeExecutable = process.execPath,
    npmExecutablePath = process.env.npm_execpath,
  } = {},
) => {
  if (platform !== 'win32') {
    return { command: 'npm', arguments: arguments_ };
  }

  const npmCliPath = npmExecutablePath?.trim();
  if (!npmCliPath) {
    refuse('npm_execpath is missing; run the local demo through npm.');
  }

  return {
    command: nodeExecutable,
    arguments: [npmCliPath, ...arguments_],
  };
};
