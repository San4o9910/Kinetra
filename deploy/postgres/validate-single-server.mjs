import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvironment, validateFiles } from '../../ops/validate-production-env.mjs';

const metadataKeys = [
  'POSTGRES_IMAGE',
  'KINETRA_POSTGRES_DATA_DIR',
  'KINETRA_POSTGRES_CA_FILE',
  'KINETRA_POSTGRES_CERT_FILE',
  'KINETRA_POSTGRES_KEY_FILE',
  'KINETRA_POSTGRES_SECRETS_DIR',
  'KINETRA_EDGE_CONFIG_DIR',
];
const roles = [
  'bootstrap',
  'migrate',
  'api',
  'notifications',
  'renewals',
  'chat_cleanup',
  'video_cleanup',
  'video_verify',
];
const fail = (reason) => {
  throw new Error(`Invalid single-server configuration: ${reason}.`);
};
function pathInfo(path, directory = false) {
  if (!isAbsolute(path ?? '') || realpathSync(path) !== path)
    fail('absolute existing paths without symlink indirection are required');
  const info = lstatSync(path);
  if (directory ? !info.isDirectory() : !info.isFile()) fail('unexpected file or directory type');
  return info;
}
export function validateEdgeConfigDirectory(path) {
  // Public metadata is passed to Compose: refuse whitespace, interpolation,
  // URI-like values and source-tree templates before considering a bind mount.
  if (typeof path !== 'string' || !/^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/.test(path))
    fail('edge configuration requires a canonical public absolute path');
  const sourceRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  if (path === sourceRoot || path.startsWith(`${sourceRoot}/`))
    fail('edge configuration must be created separately outside the checkout');
  const directory = pathInfo(path, true);
  if (directory.uid !== 0 || (directory.mode & 0o7777) !== 0o755)
    fail('edge configuration directory must be root-owned mode0755');
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const ancestor = pathInfo(parent, true);
    if (ancestor.uid !== 0 || (ancestor.mode & 0o022) !== 0)
      fail('edge configuration ancestors must be root-owned and not group/world writable');
    if (parent === '/') break;
  }
  const names = readdirSync(path);
  if (names.length !== 1 || names[0] !== 'nginx-real-ip.conf')
    fail('edge configuration directory must contain only nginx-real-ip.conf');
  const file = join(path, 'nginx-real-ip.conf');
  const info = pathInfo(file);
  if (info.uid !== 0 || (info.mode & 0o7777) !== 0o644 || info.size < 1 || info.size > 512)
    fail('edge configuration must be a small root-owned mode0644 public file');
  const content = readFileSync(file, 'utf8');
  const match =
    /^set_real_ip_from ([0-9A-Fa-f:.]+)\/(32|128);\nreal_ip_header X-Forwarded-For;\nreal_ip_recursive off;\n?$/.exec(
      content,
    );
  if (
    !match ||
    match[0] !== content ||
    !((isIP(match[1]) === 4 && match[2] === '32') || (isIP(match[1]) === 6 && match[2] === '128'))
  )
    fail('edge trust requires exactly one numeric IPv4 /32 or IPv6 /128 peer and fixed headers');
  // Syntax cannot prove which peer nginx actually sees through host/Docker NAT.
  // The operator must verify that socket peer with a synthetic request first.
  return match[1];
}
function checkUrl(values, role, password) {
  const url = new URL(values.DATABASE_URL);
  if (
    url.hostname !== 'postgres' ||
    (url.port && url.port !== '5432') ||
    url.pathname !== '/kinetra' ||
    url.search !== '?sslmode=verify-full' ||
    decodeURIComponent(url.username) !== `kinetra_${role}` ||
    decodeURIComponent(url.password) !== password
  ) {
    fail('database hostname, TLS mode or dedicated role credential does not match');
  }
}
export function validateSingleServer(singleFile, mainFile, jobName, jobFile) {
  pathInfo(singleFile);
  const values = readEnvironment(singleFile);
  if (
    Object.keys(values).length !== metadataKeys.length ||
    Object.keys(values).some((key) => !metadataKeys.includes(key))
  )
    fail('unexpected or missing metadata keys');
  validateEdgeConfigDirectory(values.KINETRA_EDGE_CONFIG_DIR);
  if (
    !/^(docker.io\/library\/)?postgres:17(\.[0-9]+)?-bookworm@sha256:[a-f0-9]{64}$/.test(
      values.POSTGRES_IMAGE,
    )
  )
    fail('reviewed official PostgreSQL 17 bookworm digest required');
  const data = pathInfo(values.KINETRA_POSTGRES_DATA_DIR, true);
  if ((data.mode & 0o777) !== 0o700 || data.uid !== 999)
    fail('data directory must be UID999 mode0700');
  const secretDir = pathInfo(values.KINETRA_POSTGRES_SECRETS_DIR, true);
  if ((secretDir.mode & 0o077) !== 0) fail('secret directory must be private');
  const passwords = {};
  for (const role of roles) {
    const path = join(values.KINETRA_POSTGRES_SECRETS_DIR, `${role}_password`);
    const info = pathInfo(path);
    if ((info.mode & 0o777) !== 0o600 || info.uid !== 999)
      fail('password files must be UID999 mode0600');
    const password = readFileSync(path, 'utf8').replace(/\n$/, '');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(password))
      fail('password files require independently generated base64url secrets');
    passwords[role] = password;
  }
  if (new Set(Object.values(passwords)).size !== roles.length)
    fail('database role passwords must be distinct');
  for (const name of ['KINETRA_POSTGRES_CA_FILE', 'KINETRA_POSTGRES_CERT_FILE']) {
    const info = pathInfo(values[name]);
    if ((info.mode & 0o022) !== 0 || (info.mode & 0o444) !== 0o444)
      fail('public certificates must be readable but not group/world writable');
    if (/PRIVATE KEY/.test(readFileSync(values[name], 'utf8')))
      fail('public certificate file contains private key material');
  }
  const keyInfo = pathInfo(values.KINETRA_POSTGRES_KEY_FILE);
  if ((keyInfo.mode & 0o777) !== 0o600 || keyInfo.uid !== 999)
    fail('server key must be UID999 mode0600');
  const ca = new X509Certificate(readFileSync(values.KINETRA_POSTGRES_CA_FILE));
  const cert = new X509Certificate(readFileSync(values.KINETRA_POSTGRES_CERT_FILE));
  const now = Date.now();
  for (const certificate of [ca, cert]) {
    if (
      Date.parse(certificate.validFrom) > now ||
      Date.parse(certificate.validTo) <= now + 14 * 86400000
    )
      fail('certificate is not valid for at least fourteen more days');
  }
  if (
    !ca.ca ||
    !ca.verify(ca.publicKey) ||
    cert.ca ||
    !cert.verify(ca.publicKey) ||
    !cert.subjectAltName?.split(', ').includes('DNS:postgres') ||
    cert.checkHost('postgres') !== 'postgres' ||
    !cert.keyUsage?.includes('1.3.6.1.5.5.7.3.1')
  )
    fail('CA-signed PostgreSQL server certificate with DNS:postgres and serverAuth is required');
  const publicKey = createPublicKey(
    createPrivateKey(readFileSync(values.KINETRA_POSTGRES_KEY_FILE)),
  );
  if (
    !publicKey
      .export({ type: 'spki', format: 'der' })
      .equals(cert.publicKey.export({ type: 'spki', format: 'der' }))
  )
    fail('server key does not match certificate');
  const main = validateFiles(mainFile, jobName, jobFile);
  if (jobName) {
    const role = jobName.replaceAll('-', '_');
    checkUrl(readEnvironment(jobFile, true), role, passwords[role]);
  } else {
    checkUrl(readEnvironment(main.KINETRA_API_ENV_FILE, true), 'api', passwords.api);
  }
  return values;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (![4, 6].includes(process.argv.length))
      fail(
        'usage: node deploy/postgres/validate-single-server.mjs /absolute/single-server.env /absolute/production.env [job /absolute/job.env]',
      );
    validateSingleServer(...process.argv.slice(2));
    console.log(
      'KINETRA_SINGLE_SERVER_CONFIG=VALIDATED_LOCAL (no service or required infrastructure gate executed)',
    );
  } catch {
    // Even parser/crypto/filesystem errors must not echo credentials or filenames.
    console.error(
      'Single-server configuration rejected; review public metadata, edge peer trust, dedicated credential files, certificate chain/permissions and production validation.',
    );
    process.exitCode = 1;
  }
}
