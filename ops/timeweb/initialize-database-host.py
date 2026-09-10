#!/usr/bin/env python3
"""Initialize only the approved empty Kinetra PostgreSQL database.

The stage and all images/sources must match one qualified app commit. No API,
frontend, provider worker, payment, message, ACME, purchase or data deletion.
Partial initialization is retained and refused on another initial invocation.
"""
from __future__ import annotations
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import resource
import shlex
import signal
import sys
import tempfile
import time

_spec = importlib.util.spec_from_file_location("kinetra_database_stage", Path(__file__).with_name("prepare-database-host.py"))
stage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(stage)
inspection = stage.inspection
bootstrap = stage.bootstrap
Error = stage.Error
PINNED_FINGERPRINT = stage.PINNED_FINGERPRINT
PREPARE_SECONDS = 1800
REMOTE_SECONDS = 1200
MIGRATIONS = (
    "001_auth.sql", "002_content.sql", "003_survey.sql", "004_base_lessons.sql",
    "005_program_media_availability.sql", "006_schedule_copy.sql", "007_progress_data_contract.sql",
    "008_notifications.sql", "009_payments.sql", "010_push_notifications.sql", "011_trainer_chat.sql",
    "012_video_uploads.sql", "013_trainer_verification.sql",
)


def migration_hashes(checkout, commit):
    command = ["/usr/bin/git", "-C", checkout]
    code, files, _ = inspection.run_bounded(command + ["ls-tree", "-r", "--name-only", commit, "--", "apps/backend/migrations"], 10)
    expected = ["apps/backend/migrations/" + name for name in MIGRATIONS]
    if code != 0 or files.decode().splitlines() != list(expected):
        raise Error("EXACT_MIGRATION_SET_REQUIRED")
    result = {}
    for name in MIGRATIONS:
        path = "apps/backend/migrations/" + name
        code, tree, _ = inspection.run_bounded(command + ["ls-tree", commit, "--", path], 10)
        if code != 0 or not re.fullmatch(rb"100644 blob [a-f0-9]{40}\t" + re.escape(path.encode()) + rb"\n", tree):
            raise Error("MIGRATION_REGULAR_BLOB_REQUIRED")
        code, body, _ = inspection.run_bounded(command + ["show", commit + ":" + path], 10, limit=262144)
        if code != 0 or not body: raise Error("MIGRATION_BLOB_UNAVAILABLE")
        result[name] = hashlib.sha256(body).hexdigest()
    return result


# Explicitly reuse the reviewed staging helper namespace. Its __main__ guard is
# false and its staging main is never called or replaced. This program owns the
# separate mutating initialization sequence below.
GUEST_INITIALIZE = (
    "shared = {'__name__': 'kinetra_staging_helpers'}\nexec(" + repr(stage.GUEST_PREPARE) + ", shared)\n"
    + r"""
import base64, hashlib, json, os, pathlib, re, resource, secrets, signal, stat, tempfile, time
STAGE = shared['STAGE']
NETWORK = shared['NETWORK']
Error = shared['StageError']
command = shared['command']
safe_parent = shared['safe_parent']
write_new = shared['write_new']
disposable_container = shared['disposable_container']
MIGRATIONS = (
    '001_auth.sql', '002_content.sql', '003_survey.sql', '004_base_lessons.sql',
    '005_program_media_availability.sql', '006_schedule_copy.sql', '007_progress_data_contract.sql',
    '008_notifications.sql', '009_payments.sql', '010_push_notifications.sql', '011_trainer_chat.sql',
    '012_video_uploads.sql', '013_trainer_verification.sql',
)
COUNTS = {'program_weeks': 12, 'program_days': 84, 'base_lessons': 7, 'workouts': 84, 'achievements': 5}

def read_file(path, mode=None, uid=0, limit=262144):
    safe_parent(path.parent)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022 or info.st_size > limit:
        raise Error('STAGED_FILE_IDENTITY_INVALID')
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise Error('STAGED_FILE_MODE_INVALID')
    return path.read_bytes()

def read_env(path):
    values = {}
    for line in read_file(path, mode=0o600).decode('ascii').splitlines():
        if not line.strip() or line.lstrip().startswith('#'): continue
        match = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)', line)
        if not match or match[1] in values or match[2] != match[2].strip() or any(ord(c) < 32 or ord(c) in (127, 36, 39, 34, 96) for c in match[2]):
            raise Error('STAGED_ENV_SYNTAX_INVALID')
        values[match[1]] = match[2]
    return values

def validate_input(data):
    if not isinstance(data, dict) or set(data) != {'commit', 'images', 'files', 'migrations'}:
        raise Error('INITIALIZATION_INPUT_INVALID')
    if not isinstance(data['commit'], str) or not re.fullmatch(r'[a-f0-9]{40}', data['commit']):
        raise Error('INITIALIZATION_COMMIT_INVALID')
    if not isinstance(data['images'], dict) or set(data['images']) != set(shared['IMAGE_PATTERNS']):
        raise Error('INITIALIZATION_IMAGES_INVALID')
    for name, pattern in shared['IMAGE_PATTERNS'].items():
        if not isinstance(data['images'][name], str) or not re.fullmatch(pattern, data['images'][name]):
            raise Error('INITIALIZATION_IMAGES_INVALID')
    if not isinstance(data['files'], dict) or set(data['files']) != set(shared['SOURCE_PATHS']):
        raise Error('INITIALIZATION_SOURCES_INVALID')
    for name, value in data['files'].items():
        if not isinstance(value, dict) or set(value) != {'sha256', 'base64'}:
            raise Error('INITIALIZATION_SOURCES_INVALID')
        try: source = base64.b64decode(value['base64'], validate=True)
        except Exception: raise Error('INITIALIZATION_SOURCES_INVALID') from None
        if hashlib.sha256(source).hexdigest() != value['sha256']:
            raise Error('INITIALIZATION_SOURCES_INVALID')
    if not isinstance(data['migrations'], dict) or set(data['migrations']) != set(MIGRATIONS) or any(not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{64}', value) for value in data['migrations'].values()):
        raise Error('INITIALIZATION_MIGRATIONS_INVALID')

def validate_existing_stage(data):
    if os.geteuid() != 0: raise Error('ROOT_REQUIRED')
    safe_parent(STAGE)
    info = STAGE.lstat()
    if stat.S_IMODE(info.st_mode) != 0o700: raise Error('STAGE_PRIVACY_INVALID')
    evidence = json.loads(read_file(STAGE / 'evidence/stage.json', mode=0o600, limit=32768))
    required = {'schema', 'result', 'stage', 'error', 'commit', 'observed_peer', 'network_id',
        'registry_config_cleanup', 'database_initialized', 'application_started', 'images', 'source_hashes'}
    if not isinstance(evidence, dict) or set(evidence) != required or evidence['schema'] != 1 or evidence['result'] != 'STAGED_ONLY' or evidence['stage'] != 'STAGING_COMPLETE' or evidence['error'] is not None or evidence['database_initialized'] is not False or evidence['application_started'] is not False or evidence['registry_config_cleanup'] != 'REMOVED':
        raise Error('SUCCESSFUL_STAGING_EVIDENCE_REQUIRED')
    if evidence['commit'] != data['commit'] or evidence['images'] != data['images'] or evidence['source_hashes'] != {name: item['sha256'] for name, item in data['files'].items()}:
        raise Error('STAGING_APPROVED_IDENTITY_MISMATCH')
    for name, item in data['files'].items():
        if hashlib.sha256(read_file(STAGE / 'source' / name, mode=0o644)).hexdigest() != item['sha256']:
            raise Error('STAGED_SOURCE_HASH_MISMATCH')
    main = read_env(STAGE / 'env/production.env')
    expected_main = {name: data['images'][name] for name in ('NODE_IMAGE', 'NGINX_IMAGE', 'BACKEND_IMAGE', 'FRONTEND_IMAGE')}
    expected_main.update(VCS_REF=data['commit'], VITE_API_URL='https://80.68.156.131', VITE_PRIVATE_MEDIA_ORIGIN='',
        KINETRA_API_ENV_FILE=str(STAGE / 'env/api.env'), KINETRA_VIDEO_SCRATCH_DIR='')
    if main != expected_main: raise Error('STAGED_PUBLIC_METADATA_MISMATCH')
    single = read_env(STAGE / 'env/single-server.env')
    expected_single = {'POSTGRES_IMAGE': data['images']['POSTGRES_IMAGE'], 'KINETRA_POSTGRES_DATA_DIR': str(STAGE / 'postgres/data'),
        'KINETRA_POSTGRES_CA_FILE': str(STAGE / 'tls/issued/public/ca.crt'),
        'KINETRA_POSTGRES_CERT_FILE': str(STAGE / 'tls/issued/public/server.crt'),
        'KINETRA_POSTGRES_KEY_FILE': str(STAGE / 'tls/issued/server-private/server.key'),
        'KINETRA_POSTGRES_SECRETS_DIR': str(STAGE / 'postgres/secrets'), 'KINETRA_EDGE_CONFIG_DIR': str(STAGE / 'edge')}
    if single != expected_single: raise Error('STAGED_DATABASE_METADATA_MISMATCH')
    if read_env(STAGE / 'env/api.env') != {'NODE_ENV': 'production'}:
        raise Error('API_MUST_REMAIN_EXPLICITLY_INCOMPLETE')
    edge = read_file(STAGE / 'edge/nginx-real-ip.conf', mode=0o644).decode('ascii')
    if not edge.startswith('set_real_ip_from ' + str(evidence['observed_peer']) + '/'):
        raise Error('STAGED_EDGE_OBSERVATION_MISMATCH')
    shared['validate_network'](evidence['network_id'])
    data_directory = STAGE / 'postgres/data'
    data_info = data_directory.lstat()
    if not stat.S_ISDIR(data_info.st_mode) or data_info.st_uid != 999 or stat.S_IMODE(data_info.st_mode) != 0o700 or any(data_directory.iterdir()):
        raise Error('EXISTING_OR_PARTIAL_DATABASE_PRESERVED')
    if command(['/usr/bin/docker', 'container', 'ls', '--all', '--quiet'], capture=True).strip():
        raise Error('EXISTING_CONTAINERS_PRESERVED')
    if command(['/usr/bin/docker', 'volume', 'ls', '--quiet'], capture=True).strip():
        raise Error('EXISTING_VOLUMES_PRESERVED')
    for name in ('initialization-attempt.json', 'initialization.json'):
        if (STAGE / 'evidence' / name).exists() or (STAGE / 'evidence' / name).is_symlink():
            raise Error('EXISTING_INITIALIZATION_EVIDENCE_PRESERVED')
    networks = command(['/usr/bin/docker', 'network', 'ls', '--format', '{{.Name}}'], capture=True).splitlines()
    if set(networks) != {'bridge', 'host', 'none', NETWORK}:
        raise Error('EXISTING_UNREVIEWED_NETWORK_PRESERVED')
    for name in ('BACKEND_IMAGE', 'FRONTEND_IMAGE'):
        revision = command(['/usr/bin/docker', 'image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', data['images'][name]], capture=True).strip()
        if revision != data['commit']: raise Error('APPROVED_LOCAL_IMAGE_REQUIRED')
    # No download or fallback: every subsequent Compose command uses --pull never.
    command(['/usr/bin/docker', 'image', 'inspect', '--format', '{{.Id}}', data['images']['POSTGRES_IMAGE']], capture=True)
    shared['validate_stage'](data['images']['BACKEND_IMAGE'])
    return evidence

def compose(arguments, *, timeout=30, capture=False):
    prefix = ['/usr/bin/env', '-i', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL=C',
        'KINETRA_JOB_ENV_FILE=' + str(STAGE / 'env/jobs/migrate.env'),
        '/usr/bin/docker', 'compose', '--project-name', 'kinetra-production',
        '--env-file', str(STAGE / 'env/production.env'), '--env-file', str(STAGE / 'env/single-server.env'),
        '-f', str(STAGE / 'source/deploy/compose.production.yml'),
        '-f', str(STAGE / 'source/deploy/compose.single-server.yml'), '--profile', 'jobs']
    return command(prefix + arguments, timeout=timeout, capture=capture)

def wait_for_database():
    identifier = compose(['ps', '--all', '--quiet', 'postgres'], capture=True).strip()
    if not re.fullmatch(r'[a-f0-9]{64}', identifier): raise Error('POSTGRES_CONTAINER_ID_REQUIRED')
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        status = command(['/usr/bin/docker', 'inspect', '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', identifier], capture=True).strip()
        if status == 'running healthy': return identifier
        if status not in {'created ', 'running starting', 'created', 'running'}:
            raise Error('POSTGRES_BOOTSTRAP_FAILED_DATA_PRESERVED')
        time.sleep(2)
    raise Error('POSTGRES_BOOTSTRAP_DEADLINE_DATA_PRESERVED')

def owned_job_identity(name, nonce, image):
    result = command(['/usr/bin/docker', 'inspect', '--type', 'container', '--format',
        '{{.Id}}\n{{index .Config.Labels "com.kinetra.initialization"}}\n{{.Config.Image}}', name], capture=True).splitlines()
    if len(result) != 3 or not re.fullmatch(r'[a-f0-9]{64}', result[0]) or result[1:] != [nonce, image]:
        raise Error('INITIALIZATION_JOB_IDENTITY_MISMATCH')
    return result[0]

def run_job(arguments, image, *, timeout=120, mounts=()):
    nonce = secrets.token_hex(12)
    name = 'kinetra-init-job-' + nonce
    identifier = None
    attempted = False
    try:
        options = ['run', '--detach', '--no-deps', '-T', '--pull', 'never', '--name', name,
            '--label', 'com.kinetra.initialization=' + nonce]
        for source, target in mounts:
            options.extend(['--volume', str(source) + ':' + target + ':ro'])
        attempted = True
        identifier = compose(options + ['migrate', *arguments], timeout=45, capture=True).strip()
        if not re.fullmatch(r'[a-f0-9]{64}', identifier) or owned_job_identity(name, nonce, image) != identifier:
            raise Error('INITIALIZATION_JOB_IDENTITY_MISMATCH')
        exit_code = command(['/usr/bin/docker', 'wait', identifier], timeout=timeout, capture=True).strip()
        if exit_code != '0': raise Error('INITIALIZATION_JOB_FAILED_DATA_PRESERVED')
        return command(['/usr/bin/docker', 'logs', identifier], capture=True)
    finally:
        # Reconcile an uncertain create response by the unique name, label and
        # exact approved image; never delete a same-name unverified container.
        verified = None
        if attempted:
            try: verified = owned_job_identity(name, nonce, image)
            except Error:
                if identifier is not None: raise
        if verified is not None:
            command(['/usr/bin/docker', 'rm', '--force', '--volumes', verified])

NODE_PREAMBLE = r'''
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
const timer = setTimeout(() => { console.error('KINETRA_INITIALIZATION_JOB_TIMEOUT'); process.exit(1); }, 90000);
const { parseDatabaseUrl } = await import('/app/apps/backend/dist/config/database.js');
const url = parseDatabaseUrl('production', process.env.DATABASE_URL);
assert.equal(new URL(url).hostname, 'postgres');
assert.equal(new URL(url).search, '?sslmode=verify-full');
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000, statement_timeout: 20000, query_timeout: 25000, lock_timeout: 5000, idle_in_transaction_session_timeout: 30000 });
let failed;
let connectionFailed = false;
client.on('error', () => { connectionFailed = true; });
try {
  await client.connect();
'''
NODE_END = r'''
  assert.equal(connectionFailed, false);
} catch (error) {
  failed = error;
  try { await client.query('ROLLBACK'); } catch {}
} finally {
  try { await client.end(); } catch (error) { failed ??= error; }
  clearTimeout(timer);
}
if (failed) {
  const code = typeof failed.code === 'string' && /^[0-9][A-Z0-9]{4}$/.test(failed.code) ? failed.code : 'UNKNOWN';
  console.error('KINETRA_INITIALIZATION_JOB_FAILED=' + code);
  process.exitCode = 1;
} else {
  console.log('KINETRA_INITIALIZATION_JOB=PASS');
}
'''
VERSION_SQL = r'''
  await client.query('BEGIN READ ONLY');
  await client.query('SET LOCAL row_security = off');
  await client.query('SET LOCAL search_path = public, pg_catalog');
  const version = await client.query("SELECT current_setting('server_version_num') AS version, current_user AS role, current_database() AS database");
  assert.ok(Number(version.rows[0].version) >= 170000 && Number(version.rows[0].version) < 180000);
  assert.equal(version.rows[0].database, 'kinetra');
  const tls = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  assert.equal(tls.rows[0].ssl, true);
'''
def node_program(body):
    return ['node', '--input-type=module', '-e', NODE_PREAMBLE + body + NODE_END]

def verify_job_output(output):
    if output.strip() != 'KINETRA_INITIALIZATION_JOB=PASS': raise Error('READONLY_ACCEPTANCE_NOT_CONFIRMED')

def validate_ledger(data, image):
    body = VERSION_SQL + "assert.equal(version.rows[0].role, 'kinetra_migrate');\n"
    body += 'const expected = ' + json.dumps(data['migrations'], sort_keys=True) + ';\n'
    body += r'''
  const directory = '/app/apps/backend/migrations';
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.sql')).sort(), Object.keys(expected).sort());
  for (const [name, hash] of Object.entries(expected)) {
    assert.equal(createHash('sha256').update(readFileSync(directory + '/' + name)).digest('hex'), hash);
  }
  const ledger = await client.query('SELECT filename, checksum FROM schema_migrations ORDER BY filename');
  assert.deepEqual(Object.fromEntries(ledger.rows.map(row => [row.filename, row.checksum])), expected);
  await client.query('COMMIT');
'''
    verify_job_output(run_job(node_program(body), image))

def runtime_grants(image):
    body = r'''
  const identity = await client.query('SELECT current_user AS role');
  assert.equal(identity.rows[0].role, 'kinetra_migrate');
  const raw = readFileSync('/run/kinetra-runtime-grants.sql', 'utf8');
  const commands = raw.split(/\r?\n/).filter(line => line.trimStart().startsWith('\\'));
  assert.deepEqual(commands, ['\\set ON_ERROR_STOP on']);
  const sql = raw.replace(/^\\set ON_ERROR_STOP on\r?\n/m, '');
  assert.equal(sql.split(/\r?\n/).some(line => line.trimStart().startsWith('\\')), false);
  await client.query(sql);
'''
    verify_job_output(run_job(node_program(body), image, mounts=((STAGE / 'source/deploy/postgres/runtime-grants.sql', '/run/kinetra-runtime-grants.sql'),)))

def readonly_api_acceptance(image):
    body = VERSION_SQL + r'''
  assert.equal(version.rows[0].role, 'kinetra_api');
  const count = await client.query("SELECT (SELECT count(*)::integer FROM users) AS users, (SELECT count(*)::integer FROM program_weeks) AS weeks, (SELECT count(*)::integer FROM program_days) AS days, (SELECT count(*)::integer FROM videos WHERE type='base_lesson') AS lessons, (SELECT count(*)::integer FROM videos WHERE type='workout') AS workouts, (SELECT count(*)::integer FROM achievements) AS achievements");
  assert.deepEqual(count.rows[0], { users: 0, weeks: 12, days: 84, lessons: 7, workouts: 84, achievements: 5 });
  const access = await client.query("SELECT has_table_privilege(current_user,'schema_migrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ledger, has_schema_privilege(current_user,'public','CREATE') AS schema_create, (SELECT bool_and(has_table_privilege(current_user,'users',p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p) AS users");
  assert.deepEqual(access.rows[0], { ledger: false, schema_create: false, users: true });
  const roles = await client.query("SELECT rolname, rolcanlogin, rolconnlimit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
    [['kinetra_migrate','kinetra_api','kinetra_notifications','kinetra_renewals','kinetra_chat_cleanup','kinetra_video_cleanup','kinetra_video_verify']]);
  assert.equal(roles.rowCount, 7);
  assert.equal(roles.rows.every(row => row.rolcanlogin && row.rolconnlimit === (row.rolname === 'kinetra_api' ? 12 : 2) && !row.rolsuper && !row.rolcreatedb && !row.rolcreaterole && !row.rolreplication && !row.rolbypassrls), true);
  const owner = await client.query("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='kinetra'");
  assert.equal(owner.rows[0].owner, 'kinetra_migrate');
  await client.query('COMMIT');
'''
    readonly_role_acceptance('api', image, body)
    for role in ('notifications', 'renewals', 'chat_cleanup', 'video_cleanup', 'video_verify'):
        body = VERSION_SQL + "assert.equal(version.rows[0].role, 'kinetra_" + role + "'); await client.query('COMMIT');"
        readonly_role_acceptance(role, image, body)

def readonly_role_acceptance(role, image, body):
    if role not in ('api', 'notifications', 'renewals', 'chat_cleanup', 'video_cleanup', 'video_verify'):
        raise Error('READONLY_ROLE_SCOPE_INVALID')
    password = read_file(STAGE / 'postgres/secrets' / (role + '_password'), mode=0o600, uid=999).decode('ascii').removesuffix('\n')
    if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', password): raise Error('READONLY_CHECK_PASSWORD_FORMAT_INVALID')
    with tempfile.TemporaryDirectory(prefix='kinetra-role-db-check-', dir='/run') as temporary:
        os.chmod(temporary, 0o700)
        env_file = pathlib.Path(temporary) / 'database.env'
        write_new(env_file, ('NODE_ENV=production\nDATABASE_URL=postgresql://kinetra_' + role + ':' + password + '@postgres:5432/kinetra?sslmode=verify-full\n').encode())
        options = ['--network', 'kinetra-production_database', '--user', '1000:1000', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32',
            '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.25', '--env-file', str(env_file),
            '--env', 'NODE_EXTRA_CA_CERTS=/run/kinetra/postgres-ca.crt',
            '--mount', 'type=bind,source=' + str(STAGE / 'tls/issued/public/ca.crt') + ',target=/run/kinetra/postgres-ca.crt,readonly']
        verify_job_output(disposable_container(options, image, node_program(body), timeout=120, capture=True))
    password = None

def final_isolation(postgres_id, image, network_id):
    identifiers = command(['/usr/bin/docker', 'container', 'ls', '--all', '--quiet', '--no-trunc'], capture=True).splitlines()
    if identifiers != [postgres_id]: raise Error('UNEXPECTED_RETAINED_CONTAINER')
    ports = command(['/usr/bin/docker', 'port', postgres_id], capture=True)
    if ports.strip(): raise Error('POSTGRES_PORT_PUBLICATION_REFUSED')
    networks = json.loads(command(['/usr/bin/docker', 'inspect', '--format', '{{json .NetworkSettings.Networks}}', postgres_id], capture=True))
    if set(networks) != {'kinetra-production_database'}: raise Error('POSTGRES_NETWORK_ISOLATION_INVALID')
    private = json.loads(command(['/usr/bin/docker', 'network', 'inspect', '--format', '{{json .}}', 'kinetra-production_database'], capture=True))
    if private.get('Internal') is not True or private.get('Labels', {}).get('com.docker.compose.project') != 'kinetra-production' or set(private.get('Containers', {})) != {postgres_id}:
        raise Error('POSTGRES_NETWORK_ISOLATION_INVALID')
    actual_image = command(['/usr/bin/docker', 'inspect', '--format', '{{.Config.Image}}', postgres_id], capture=True).strip()
    if actual_image != image: raise Error('POSTGRES_IMAGE_IDENTITY_INVALID')
    restart = command(['/usr/bin/docker', 'inspect', '--format', '{{.HostConfig.RestartPolicy.Name}}', postgres_id], capture=True).strip()
    if restart != 'no': raise Error('POSTGRES_AUTOMATIC_RESTART_REFUSED')
    volumes = command(['/usr/bin/docker', 'volume', 'ls', '--quiet'], capture=True).splitlines()
    if volumes != ['kinetra-production_postgres17_data']: raise Error('POSTGRES_VOLUME_SCOPE_INVALID')
    volume = json.loads(command(['/usr/bin/docker', 'volume', 'inspect', '--format', '{{json .}}', volumes[0]], capture=True))
    if volume.get('Driver') != 'local' or volume.get('Options') != {'type': 'none', 'o': 'bind', 'device': str(STAGE / 'postgres/data')} or volume.get('Labels', {}).get('com.docker.compose.project') != 'kinetra-production':
        raise Error('POSTGRES_VOLUME_IDENTITY_INVALID')
    shared['validate_network'](network_id)
    listeners = command(['/usr/bin/ss', '-H', '-lnt'], capture=True)
    if any(len(row.split()) >= 4 and row.split()[3].rsplit(':', 1)[-1] in {'5432', '8080'} for row in listeners.splitlines()):
        raise Error('UNEXPECTED_PUBLIC_DATABASE_OR_APP_LISTENER')

def main():
    state = {'schema': 1, 'result': 'FAIL', 'stage': 'INPUT', 'error': None, 'commit': None,
        'postgres_id': None, 'database_initialized': False, 'application_started': False,
        'migrations': 0, 'content_seed': False, 'runtime_grants': False, 'readonly_acceptance': False}
    lock = None
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        raw = __import__('sys').stdin.buffer.read(1048577)
        if len(raw) > 1048576: raise Error('INITIALIZATION_INPUT_TOO_LARGE')
        data = json.loads(raw)
        validate_input(data)
        state['commit'] = data['commit']
        # Serialize with initial staging. No existing lock contents are changed.
        lock = os.open('/run/kinetra-database-stage.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077: raise Error('LOCK_FILE_UNSAFE')
        try: shared['fcntl'].flock(lock, shared['fcntl'].LOCK_EX | shared['fcntl'].LOCK_NB)
        except BlockingIOError: raise Error('DATABASE_STAGE_OR_INITIALIZATION_ACTIVE') from None
        state['stage'] = 'VALIDATE_EMPTY_STAGED_DATABASE'
        evidence = validate_existing_stage(data)
        state['stage'] = 'COMPOSE_CONFIGURATION'
        compose(['config', '--quiet'])
        state['stage'] = 'INITIALIZE_POSTGRES_ONCE'
        attempt = {'schema': 1, 'commit': data['commit'], 'images': data['images'], 'migration_hashes': data['migrations']}
        write_new(STAGE / 'evidence/initialization-attempt.json', (json.dumps(attempt, sort_keys=True) + '\n').encode())
        parent = os.open(STAGE / 'evidence', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try: os.fsync(parent)
        finally: os.close(parent)
        compose(['up', '--detach', '--no-deps', '--no-build', '--pull', 'never', 'postgres'], timeout=120)
        state['postgres_id'] = wait_for_database()
        state['database_initialized'] = True
        state['stage'] = 'POSTGRES_TLS_AND_ROLE'
        verify_job_output(run_job(node_program(VERSION_SQL + "assert.equal(version.rows[0].role, 'kinetra_migrate'); const existing = await client.query(\"SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname='public'\"); assert.equal(existing.rows[0].count, 0); await client.query('COMMIT');"), data['images']['BACKEND_IMAGE']))
        state['stage'] = 'MIGRATIONS'
        output = run_job([], data['images']['BACKEND_IMAGE'], timeout=180)
        if output.splitlines() != ['APPLY ' + name for name in MIGRATIONS]: raise Error('INITIAL_MIGRATION_RESULTS_INVALID')
        state['migrations'] = len(MIGRATIONS)
        validate_ledger(data, data['images']['BACKEND_IMAGE'])
        state['stage'] = 'INITIAL_EMPTY_CONTENT_SEED'
        output = run_job(['node', 'scripts/seed.mjs', '--initial-empty-database'], data['images']['BACKEND_IMAGE'])
        lines = output.splitlines()
        if len(lines) != 2 or lines[0] != 'KINETRA_CONTENT_SEED=PASS' or json.loads(lines[1]) != COUNTS:
            raise Error('INITIAL_CONTENT_SEED_RESULTS_INVALID')
        state['content_seed'] = True
        state['stage'] = 'REVIEWED_RUNTIME_GRANTS'
        runtime_grants(data['images']['BACKEND_IMAGE'])
        state['runtime_grants'] = True
        state['stage'] = 'READONLY_DATABASE_ACCEPTANCE'
        readonly_api_acceptance(data['images']['BACKEND_IMAGE'])
        validate_ledger(data, data['images']['BACKEND_IMAGE'])
        final_isolation(state['postgres_id'], data['images']['POSTGRES_IMAGE'], evidence['network_id'])
        state['readonly_acceptance'] = True
        state['result'], state['stage'] = 'DATABASE_INITIALIZED_ONLY', 'INITIALIZATION_COMPLETE'
        write_new(STAGE / 'evidence/initialization.json', (json.dumps(dict(state, images=data['images'], migration_hashes=data['migrations']), sort_keys=True) + '\n').encode())
    except Error as error: state['result'], state['error'] = 'FAIL', str(error)
    except BaseException: state['result'], state['error'] = 'FAIL', 'UNEXPECTED_ERROR_PARTIAL_DATABASE_PRESERVED'
    finally:
        if lock is not None: os.close(lock)
        print(json.dumps(state, sort_keys=True), flush=True)
    return 0 if state['result'] == 'DATABASE_INITIALIZED_ONLY' else 1

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, shared['interrupted'])
    signal.signal(signal.SIGINT, shared['interrupted'])
    raise SystemExit(main())
"""
)


def validate_initialization_result(raw):
    try:
        data = json.loads(raw)
    except Exception:
        raise Error("REMOTE_RESULT_INVALID") from None
    keys = {"schema", "result", "stage", "error", "commit", "postgres_id",
        "database_initialized", "application_started", "migrations", "content_seed",
        "runtime_grants", "readonly_acceptance"}
    if not isinstance(data, dict) or set(data) != keys or type(data["schema"]) is not int or data["schema"] != 1:
        raise Error("REMOTE_RESULT_INVALID")
    if data["result"] not in {"FAIL", "DATABASE_INITIALIZED_ONLY"} or data["application_started"] is not False:
        raise Error("REMOTE_RESULT_INVALID")
    if not isinstance(data["stage"], str) or not re.fullmatch(r"[A-Z_]{1,64}", data["stage"]) or (data["error"] is not None and (not isinstance(data["error"], str) or not re.fullmatch(r"[A-Z_]{1,80}", data["error"]))):
        raise Error("REMOTE_RESULT_INVALID")
    for key, length in (("commit", 40), ("postgres_id", 64)):
        if data[key] is not None and (not isinstance(data[key], str) or not re.fullmatch(r"[a-f0-9]{" + str(length) + "}", data[key])):
            raise Error("REMOTE_RESULT_INVALID")
    if any(type(data[key]) is not bool for key in ("database_initialized", "content_seed", "runtime_grants", "readonly_acceptance")):
        raise Error("REMOTE_RESULT_INVALID")
    if type(data["migrations"]) is not int or not 0 <= data["migrations"] <= len(MIGRATIONS):
        raise Error("REMOTE_RESULT_INVALID")
    if data["result"] == "DATABASE_INITIALIZED_ONLY" and (data["stage"] != "INITIALIZATION_COMPLETE" or data["error"] is not None or data["commit"] is None or data["postgres_id"] is None or data["migrations"] != len(MIGRATIONS) or any(data[key] is not True for key in ("database_initialized", "content_seed", "runtime_grants", "readonly_acceptance"))):
        raise Error("REMOTE_PASS_EVIDENCE_INCOMPLETE")
    return data


def emit(state):
    print("TIMEWEB_DATABASE_INITIALIZATION=" + json.dumps(state, sort_keys=True), flush=True)


def main(argv=None, environ=None, api_factory=inspection.Api):
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    state = {"result": "IN_PROGRESS", "server_id": inspection.SERVER_ID, "public_ipv4": inspection.PUBLIC_IPV4,
        "host_key_fingerprint": None, "server_status": "UNKNOWN", "ssh_key_id": None,
        "guest_key_cleanup": "NOT_NEEDED", "account_key_cleanup": "NOT_NEEDED", "local_key_cleanup": "NOT_NEEDED",
        "initialization": None, "error": None, "application_readiness": "BLOCKED_MISSING_PROVIDER_INPUTS"}
    api, folder, payload = None, None, b""
    try:
        if argv != ["--initialize-new-empty-database"]: raise Error("EXPLICIT_DATABASE_INITIALIZATION_FLAG_REQUIRED")
        if environ.get("GITHUB_ACTIONS") != "true" or environ.get("GITHUB_REPOSITORY") != inspection.REPOSITORY or environ.get("GITHUB_RUN_ATTEMPT") != "1":
            raise Error("AUTHORIZED_NEW_GITHUB_RUN_REQUIRED")
        run_id = environ.get("GITHUB_RUN_ID", "")
        if not re.fullmatch(r"[1-9][0-9]{0,19}", run_id): raise Error("SUPPLIED_RUN_ID_INVALID")
        if environ.get("ROOT_SUPPLIED_SERVER_ID", str(inspection.SERVER_ID)) != str(inspection.SERVER_ID) or environ.get("ROOT_SUPPLIED_SERVER_IP", inspection.PUBLIC_IPV4) != inspection.PUBLIC_IPV4:
            raise Error("CONFIRMED_SERVER_OVERRIDE_REFUSED")
        runtime_temp = Path(environ.get("RUNNER_TEMP", ""))
        if not runtime_temp.is_absolute() or not runtime_temp.is_dir(): raise Error("RUNNER_TEMP_INVALID")
        token = environ.pop("TIMEWEB_CLOUD_TOKEN", "")
        # Registry authentication belongs only to the earlier bounded staging
        # step. Initialization requires the exact qualified images already local.
        environ.pop("GITHUB_TOKEN", None)
        environ.pop("GH_TOKEN", None)
        if not token or len(token) > 16384 or any(c.isspace() for c in token): raise Error("TIMEWEB_SECRET_MISSING_OR_INVALID")
        data = stage.metadata(environ)
        data["files"] = stage.source_bundle(environ.get("APP_CHECKOUT", ""), data["commit"])
        data["migrations"] = migration_hashes(environ.get("APP_CHECKOUT", ""), data["commit"])
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        deadline = time.monotonic() + PREPARE_SECONDS
        api = api_factory(token, inspection.SERVER_ID, deadline)
        del token
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        if state["server_status"] != "on": raise Error("EXISTING_SERVER_NOT_ON")
        api.server_verified = True
        folder = Path(tempfile.mkdtemp(prefix="kinetra-db-init-", dir=runtime_temp))
        os.chmod(folder, 0o700)
        state["local_key_cleanup"] = "PENDING"
        known_hosts, fingerprint = inspection.pin_host_key(inspection.PUBLIC_IPV4, folder, deadline)
        state["host_key_fingerprint"] = fingerprint
        if fingerprint != PINNED_FINGERPRINT: raise Error("PINNED_HOST_KEY_MISMATCH")
        private, public_key = inspection.prepare_key(folder, deadline)
        name = "kinetra-db-init-" + run_id
        key = inspection.ssh_key_object(api.request("POST", "/ssh-keys", {"name": name, "body": public_key, "is_default": False}))
        key_id = inspection.positive_id(key.get("id"))
        state["ssh_key_id"] = key_id
        if key.get("name") != name or key.get("body") != public_key or key.get("is_default") is not False:
            raise Error("CREATED_KEY_IDENTITY_MISMATCH")
        api.key_id = key_id
        state.update(account_key_cleanup="PENDING", guest_key_cleanup="ATTACH_OUTCOME_UNKNOWN")
        emit(state)
        api.request("POST", f"/servers/{inspection.SERVER_ID}/ssh-keys", {"ssh_key_ids": [key_id]})
        state["guest_key_cleanup"] = "PENDING"
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        if state["server_status"] != "on": raise Error("SERVER_NO_LONGER_ON")
        arguments = inspection.ssh_arguments(inspection.PUBLIC_IPV4, private, known_hosts)
        inspection.wait_for_key(arguments, deadline)
        code, output, _ = inspection.run_bounded(arguments + ["/usr/bin/python3 -c " + shlex.quote(inspection.GUEST_PROGRAM)], 215)
        if code != 0: raise Error("PRE_INITIALIZATION_INSPECTION_FAILED")
        bootstrap.require_inspected_guest(output, after=True)
        if deadline - time.monotonic() < REMOTE_SECONDS + 180: raise Error("INSUFFICIENT_INITIALIZATION_AND_CLEANUP_TIME")
        command = "/usr/bin/timeout --signal=TERM --kill-after=15s " + str(REMOTE_SECONDS) + "s /usr/bin/python3 -c " + shlex.quote(GUEST_INITIALIZE)
        payload = json.dumps(data, allow_nan=False).encode()
        code, output, _ = stage.run_with_input(arguments + [command], payload, REMOTE_SECONDS + 30)
        payload = b""
        state["initialization"] = validate_initialization_result(output)
        if state["initialization"]["commit"] != data["commit"]: raise Error("REMOTE_SOURCE_COMMIT_MISMATCH")
        if code != 0 or state["initialization"]["result"] != "DATABASE_INITIALIZED_ONLY": raise Error("REMOTE_INITIALIZATION_FAILED_PARTIAL_DATA_PRESERVED")
        state["result"] = "PASS_DATABASE_INITIALIZED_APPLICATION_NOT_STARTED"
    except Error as error: state["result"], state["error"] = "FAIL", str(error)
    except BaseException: state["result"], state["error"] = "FAIL", "UNEXPECTED_ERROR_PARTIAL_DATABASE_POSSIBLE"
    finally:
        payload = b""
        inspection.cleanup(api, folder, state)
        if any(state[key] not in {"NOT_NEEDED", "API_DELETE_CONFIRMED", "ALREADY_ABSENT", "REMOVED"} for key in ("guest_key_cleanup", "account_key_cleanup", "local_key_cleanup")):
            state["result"], state["error"] = "FAIL", state["error"] or "KEY_CLEANUP_REQUIRES_RECONCILIATION"
        emit(state)
    return 0 if state["result"] == "PASS_DATABASE_INITIALIZED_APPLICATION_NOT_STARTED" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, inspection.interrupted)
    signal.signal(signal.SIGINT, inspection.interrupted)
    sys.exit(main())
