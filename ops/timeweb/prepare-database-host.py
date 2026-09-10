#!/usr/bin/env python3
"""Stage a new Kinetra database host; deliberately never initialize/start its DB.

Only fixed server 9069403/IP 80.68.156.131. Requires qualified immutable images and
an exact approved app checkout. Creates new files, DB secrets/private TLS, pulls
images, observes a temporary loopback nginx peer and validates migrate config.
No database/application starts, migrations, ACME, purchases or provider effects.
Partial staging is preserved; a subsequent invocation refuses the existing tree.
"""
from __future__ import annotations
import base64
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import resource
import selectors
import shlex
import signal
import subprocess
import sys
import tempfile
import time

_spec = importlib.util.spec_from_file_location("kinetra_bootstrap", Path(__file__).with_name("bootstrap-server.py"))
bootstrap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bootstrap)
inspection = bootstrap.inspection
Error = inspection.InspectError
PINNED_FINGERPRINT = bootstrap.PINNED_FINGERPRINT
PREPARE_SECONDS = 1800
REMOTE_SECONDS = 1350
MAX_PAYLOAD = 1_048_576
SOURCE_PATHS = (
    "deploy/compose.production.yml", "deploy/compose.single-server.yml",
    "deploy/jobs/disabled.env.example", "deploy/postgres/start-postgres.sh",
    "deploy/postgres/postgresql.conf", "deploy/postgres/pg_hba.conf",
    "deploy/postgres/pg_ident.conf", "deploy/postgres/roles.sql",
    "deploy/postgres/runtime-grants.sql", "deploy/postgres/initdb/10-roles.sh",
    "deploy/postgres/issue-server-certificate.sh", "deploy/postgres/validate-single-server.mjs",
    "ops/validate-production-env.mjs", "ops/run-production-job.sh", "ops/prepare-single-server.sh",
)
# Docker RepoDigests omit mutable tags. Provenance binds the exact approved
# digest; known tags may be retained as metadata, never substituted for it.
IMAGE_PATTERNS = {
    "NODE_IMAGE": r"(?:docker\.io/library/)?node(?::22-(?:bookworm-slim|alpine3\.24))?@sha256:[a-f0-9]{64}",
    "NGINX_IMAGE": r"(?:docker\.io/)?nginxinc/nginx-unprivileged(?::1\.30\.4-alpine-slim)?@sha256:[a-f0-9]{64}",
    "BACKEND_IMAGE": r"ghcr\.io/san4o9910/kinetra-backend@sha256:[a-f0-9]{64}",
    "FRONTEND_IMAGE": r"ghcr\.io/san4o9910/kinetra-frontend@sha256:[a-f0-9]{64}",
    "POSTGRES_IMAGE": r"(?:docker\.io/library/)?postgres(?::17(?:\.[0-9]+)?-bookworm)?@sha256:[a-f0-9]{64}",
}


def metadata(environ):
    commit = environ.get("APPROVED_APP_COMMIT", "")
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise Error("APPROVED_APP_COMMIT_INVALID")
    result = {"commit": commit, "images": {}}
    for name, pattern in IMAGE_PATTERNS.items():
        value = environ.get(name, "")
        if not re.fullmatch(pattern, value):
            raise Error("APPROVED_IMAGE_REFERENCE_INVALID")
        result["images"][name] = value
    return result


def source_bundle(checkout, commit):
    path = Path(checkout)
    if not path.is_absolute() or not path.is_dir() or path.resolve() != path:
        raise Error("APP_CHECKOUT_INVALID")
    code, raw, _ = inspection.run_bounded(["/usr/bin/git", "-C", str(path), "rev-parse", "HEAD"], 10)
    if code != 0 or raw.decode().strip() != commit:
        raise Error("APP_CHECKOUT_COMMIT_MISMATCH")
    files = {}
    for name in SOURCE_PATHS:
        code, tree, _ = inspection.run_bounded(["/usr/bin/git", "-C", str(path), "ls-tree", commit, "--", name], 10)
        if code != 0 or not re.fullmatch(rb"100(?:644|755) blob [a-f0-9]{40}\t" + re.escape(name.encode()) + rb"\n", tree):
            raise Error("APPROVED_SOURCE_NOT_REGULAR")
        code, raw, _ = inspection.run_bounded(["/usr/bin/git", "-C", str(path), "show", commit + ":" + name], 10, limit=262144)
        if code != 0 or not raw or len(raw) > 262144:
            raise Error("APPROVED_SOURCE_BLOB_UNAVAILABLE")
        files[name] = {"sha256": hashlib.sha256(raw).hexdigest(), "base64": base64.b64encode(raw).decode("ascii")}
    if len(json.dumps(files).encode()) > MAX_PAYLOAD // 2:
        raise Error("APPROVED_SOURCE_BUNDLE_TOO_LARGE")
    return files


def run_with_input(arguments, payload, timeout):
    """Secrets travel on stdin only; bounded output and a secret-free child env."""
    if len(payload) > MAX_PAYLOAD or timeout <= 0:
        raise Error("REMOTE_INPUT_INVALID")
    process = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, env={"PATH": os.defpath, "LC_ALL": "C"}, start_new_session=True)
    output = {"stdout": bytearray(), "stderr": bytearray()}
    offset, deadline = 0, time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            for pipe, event, name in ((process.stdin, selectors.EVENT_WRITE, "stdin"),
                    (process.stdout, selectors.EVENT_READ, "stdout"), (process.stderr, selectors.EVENT_READ, "stderr")):
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, event, name)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise Error("REMOTE_STAGE_DEADLINE_EXCEEDED")
                for key, _ in selector.select(min(remaining, 1)):
                    if key.data == "stdin":
                        try:
                            offset += os.write(key.fileobj.fileno(), payload[offset:offset + 16384])
                        except BrokenPipeError:
                            offset = len(payload)
                        if offset == len(payload):
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                    else:
                        chunk = os.read(key.fileobj.fileno(), 4096)
                        if not chunk:
                            selector.unregister(key.fileobj)
                        else:
                            output[key.data].extend(chunk)
                            if sum(map(len, output.values())) > 65536:
                                raise Error("REMOTE_STAGE_OUTPUT_TOO_LARGE")
            code = process.wait(timeout=max(1, deadline - time.monotonic()))
            return code, bytes(output["stdout"]), bytes(output["stderr"])
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
        for pipe in (process.stdin, process.stdout, process.stderr):
            pipe.close()


GUEST_PREPARE = r"""
import base64, fcntl, hashlib, ipaddress, json, os, pathlib, re, resource, secrets, shutil, signal, stat, subprocess, tempfile, time, urllib.request
STAGE = pathlib.Path('/srv/kinetra-stage')
EDGE = STAGE / 'edge'
NETWORK = 'kinetra-production_backend'
ROLES = ('bootstrap', 'migrate', 'api', 'notifications', 'renewals', 'chat_cleanup', 'video_cleanup', 'video_verify')
SOURCE_PATHS = (
    'deploy/compose.production.yml', 'deploy/compose.single-server.yml',
    'deploy/jobs/disabled.env.example', 'deploy/postgres/start-postgres.sh',
    'deploy/postgres/postgresql.conf', 'deploy/postgres/pg_hba.conf',
    'deploy/postgres/pg_ident.conf', 'deploy/postgres/roles.sql',
    'deploy/postgres/runtime-grants.sql', 'deploy/postgres/initdb/10-roles.sh',
    'deploy/postgres/issue-server-certificate.sh', 'deploy/postgres/validate-single-server.mjs',
    'ops/validate-production-env.mjs', 'ops/run-production-job.sh', 'ops/prepare-single-server.sh',
)
IMAGE_PATTERNS = {
    'NODE_IMAGE': r'(?:docker\.io/library/)?node(?::22-(?:bookworm-slim|alpine3\.24))?@sha256:[a-f0-9]{64}',
    'NGINX_IMAGE': r'(?:docker\.io/)?nginxinc/nginx-unprivileged(?::1\.30\.4-alpine-slim)?@sha256:[a-f0-9]{64}',
    'BACKEND_IMAGE': r'ghcr\.io/san4o9910/kinetra-backend@sha256:[a-f0-9]{64}',
    'FRONTEND_IMAGE': r'ghcr\.io/san4o9910/kinetra-frontend@sha256:[a-f0-9]{64}',
    'POSTGRES_IMAGE': r'(?:docker\.io/library/)?postgres(?::17(?:\.[0-9]+)?-bookworm)?@sha256:[a-f0-9]{64}',
}
class StageError(Exception): pass

def interrupted(_signum, _frame):
    raise StageError('REMOTE_INTERRUPTED_PARTIAL_STATE')

def command(args, *, timeout=30, capture=False, input_data=None, cwd=None):
    environment = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}
    child = subprocess.Popen(args, stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env=environment, cwd=cwd, start_new_session=True)
    try:
        output, _ = child.communicate(input=input_data, timeout=timeout)
        if output is not None and len(output) > 65536: raise StageError('CHILD_OUTPUT_TOO_LARGE')
        if child.returncode != 0: raise StageError('CHILD_COMMAND_FAILED')
        return (output or b'').decode('utf-8', errors='strict')
    except subprocess.TimeoutExpired:
        raise StageError('CHILD_DEADLINE_EXCEEDED_PARTIAL_STATE') from None
    finally:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                if child.poll() is None: os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)

def safe_parent(path):
    path = pathlib.Path(path)
    if path.resolve() != path: raise StageError('SYMLINK_PARENT_REFUSED')
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise StageError('UNSAFE_ROOT_OWNED_PARENT')
    if path != path.parent: safe_parent(path.parent)

def new_directory(path, mode=0o700):
    safe_parent(path.parent)
    path.mkdir(mode=mode)
    os.chmod(path, mode)

def write_new(path, data, mode=0o600, uid=0):
    safe_parent(path.parent)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
        os.fchmod(stream.fileno(), mode)
        os.fchown(stream.fileno(), uid, uid)

def validate_payload(data):
    if not isinstance(data, dict) or set(data) != {'commit', 'images', 'files', 'registry_token'} or not re.fullmatch(r'[a-f0-9]{40}', data.get('commit', '')):
        raise StageError('PAYLOAD_SHAPE_INVALID')
    if not isinstance(data['images'], dict) or set(data['images']) != set(IMAGE_PATTERNS):
        raise StageError('IMAGE_SET_INVALID')
    for name, pattern in IMAGE_PATTERNS.items():
        if not isinstance(data['images'].get(name), str) or not re.fullmatch(pattern, data['images'][name]): raise StageError('IMAGE_REFERENCE_INVALID')
    token = data['registry_token']
    if not isinstance(token, str) or not 10 <= len(token) <= 16384 or any(character.isspace() for character in token):
        raise StageError('REGISTRY_TOKEN_INVALID')
    if not isinstance(data['files'], dict) or set(data['files']) != set(SOURCE_PATHS):
        raise StageError('SOURCE_SET_INVALID')
    result = {}
    for name in SOURCE_PATHS:
        entry = data['files'][name]
        if not isinstance(entry, dict) or set(entry) != {'sha256', 'base64'}: raise StageError('SOURCE_ENTRY_INVALID')
        try: raw = base64.b64decode(entry['base64'], validate=True)
        except Exception: raise StageError('SOURCE_ENCODING_INVALID') from None
        if not raw or len(raw) > 262144 or hashlib.sha256(raw).hexdigest() != entry['sha256']:
            raise StageError('SOURCE_HASH_MISMATCH')
        result[name] = raw
    return result

def validate_compose_version(version):
    match = re.fullmatch(r'v?2\.([0-9]+)\.[0-9]+(?:[-+][A-Za-z0-9.~-]+)?', version)
    if match is None or int(match[1]) < 30:
        raise StageError('COMPOSE_RAW_ENV_UNSUPPORTED')

def preconditions():
    if os.geteuid() != 0: raise StageError('ROOT_REQUIRED')
    safe_parent(STAGE.parent)
    if STAGE.exists() or STAGE.is_symlink():
        raise StageError('EXISTING_STAGE_OR_EDGE_PRESERVED')
    marker = pathlib.Path('/var/lib/kinetra/bootstrap')
    if marker.is_symlink() or not marker.is_file() or marker.read_bytes() != b'empty-server-bootstrap-v1\n':
        raise StageError('EXPECTED_EMPTY_HOST_MARKER_MISSING')
    connection = os.environ.get('SSH_CONNECTION', '').split()
    if len(connection) != 4 or connection[3] != '22': raise StageError('SSH_CONTEXT_INVALID')
    if shutil.disk_usage('/').free < 12 * 1024**3: raise StageError('INSUFFICIENT_FREE_DISK')
    if shutil.which('openssl') is None: raise StageError('OPENSSL_REQUIRED')
    if command(['/usr/bin/docker', 'container', 'ls', '--all', '--quiet'], capture=True).strip():
        raise StageError('EXISTING_CONTAINERS_PRESERVED')
    if command(['/usr/bin/docker', 'volume', 'ls', '--quiet'], capture=True).strip():
        raise StageError('EXISTING_VOLUMES_PRESERVED')
    networks = command(['/usr/bin/docker', 'network', 'ls', '--format', '{{.Name}}'], capture=True).splitlines()
    if set(networks) != {'bridge', 'host', 'none'}: raise StageError('EXISTING_CUSTOM_NETWORKS_PRESERVED')
    compose = command(['/usr/bin/docker', 'compose', 'version', '--short'], capture=True).strip()
    validate_compose_version(compose)
    sockets = command(['/usr/bin/ss', '-H', '-lnt'], capture=True)
    for row in sockets.splitlines():
        fields = row.split()
        if len(fields) < 4: raise StageError('LISTENERS_UNREADABLE')
        if fields[3].rsplit(':', 1)[-1] in {'80', '443', '5432', '8080'}:
            raise StageError('EXISTING_APPLICATION_LISTENER_PRESERVED')

def stage_sources(files):
    new_directory(STAGE)
    for relative in ('source', 'env', 'env/jobs', 'postgres', 'postgres/data', 'postgres/secrets', 'tls', 'evidence'):
        new_directory(STAGE / relative, 0o755 if relative == 'source' else 0o700)
    for name, body in files.items():
        path = STAGE / 'source' / name
        current = STAGE / 'source'
        for part in pathlib.PurePosixPath(name).parts[:-1]:
            current = current / part
            if not current.exists(): new_directory(current, 0o755)
        write_new(path, body, 0o644)
    os.chown(STAGE / 'postgres/data', 999, 999)

def create_database_secrets():
    passwords = {role: secrets.token_urlsafe(32) for role in ROLES}
    if len(set(passwords.values())) != len(ROLES): raise StageError('RANDOM_SECRET_COLLISION')
    for role, password in passwords.items():
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', password): raise StageError('RANDOM_SECRET_FORMAT_INVALID')
        write_new(STAGE / 'postgres/secrets' / (role + '_password'), (password + '\n').encode(), uid=999)
    migrate = ('NODE_ENV=production\nDATABASE_URL=postgresql://kinetra_migrate:' + passwords['migrate'] + '@postgres:5432/kinetra?sslmode=verify-full\n')
    write_new(STAGE / 'env/jobs/migrate.env', migrate.encode())
    write_new(STAGE / 'env/api.env', b'# INCOMPLETE: provider inputs absent; API must remain stopped.\nNODE_ENV=production\n')
    passwords.clear()
    command(['/bin/sh', str(STAGE / 'source/deploy/postgres/issue-server-certificate.sh'),
        '--issue-approved-certificate', str(STAGE / 'tls/issued')], timeout=90)
    key = STAGE / 'tls/issued/server-private/server.key'
    os.chown(key, 999, 999)
    os.chmod(key, 0o600)

def disposable_container(options, image, arguments, *, timeout=30, capture=False):
    container = None
    try:
        container = command(['/usr/bin/docker', 'create', '--label', 'com.kinetra.stage=database-preparation',
            *options, image, *arguments], capture=True).strip()
        if not re.fullmatch(r'[a-f0-9]{64}', container): raise StageError('DISPOSABLE_CONTAINER_ID_INVALID')
        output = command(['/usr/bin/docker', 'start', '--attach', container], timeout=timeout, capture=capture)
        status = command(['/usr/bin/docker', 'inspect', '--format', '{{.State.ExitCode}} {{.State.Running}}', container], capture=True).strip()
        if status != '0 false': raise StageError('DISPOSABLE_CONTAINER_DID_NOT_SUCCEED')
        return output
    finally:
        # Killing the attached Docker CLI does not kill its daemon-managed
        # container. Always remove only the ID created by this invocation.
        if container is not None and re.fullmatch(r'[a-f0-9]{64}', container):
            command(['/usr/bin/docker', 'rm', '--force', '--volumes', container])

def pull_images(data, state=None):
    temporary_path = None
    try:
        with tempfile.TemporaryDirectory(prefix='kinetra-registry-', dir='/run') as temporary:
            temporary_path = pathlib.Path(temporary)
            os.chmod(temporary, 0o700)
            docker = ['/usr/bin/docker', '--config', temporary]
            token = data.pop('registry_token')
            try:
                command([*docker, 'login', 'ghcr.io', '--username', 'San4o9910', '--password-stdin'],
                    timeout=45, input_data=token.encode())
            finally: token = None
            for key in ('POSTGRES_IMAGE', 'BACKEND_IMAGE', 'FRONTEND_IMAGE'):
                command([*docker, 'pull', '--platform', 'linux/amd64', data['images'][key]], timeout=240)
    finally:
        if state is not None:
            state['registry_config_cleanup'] = ('NOT_NEEDED' if temporary_path is None else
                'REMOVED' if not temporary_path.exists() and not temporary_path.is_symlink() else 'FAILED')
    for key in ('BACKEND_IMAGE', 'FRONTEND_IMAGE'):
        revision = command(['/usr/bin/docker', 'image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', data['images'][key]], capture=True).strip()
        if revision != data['commit']: raise StageError('IMAGE_REVISION_MISMATCH')
    output = disposable_container(['--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--entrypoint', 'postgres'],
        data['images']['POSTGRES_IMAGE'], ['--version'], capture=True).strip()
    if not re.fullmatch(r'postgres \(PostgreSQL\) 17\.[0-9]+(?: .*)?', output): raise StageError('POSTGRES_MAJOR_MISMATCH')
    uid = disposable_container(['--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--entrypoint', 'id'],
        data['images']['POSTGRES_IMAGE'], ['-u', 'postgres'], capture=True).strip()
    if uid != '999': raise StageError('POSTGRES_IMAGE_UID_MISMATCH')

def validate_network(network_id):
    raw = command(['/usr/bin/docker', 'network', 'inspect', '--format', '{{json .}}', NETWORK], capture=True)
    try:
        value = json.loads(raw)
        if value['Id'] != network_id or value['Name'] != NETWORK or value['Driver'] != 'bridge' or value['Internal'] is not False:
            raise ValueError()
        if value.get('Containers') != {} or value.get('EnableIPv6') is not False:
            raise ValueError()
        labels = value.get('Labels', {})
        if labels.get('com.docker.compose.project') != 'kinetra-production' or labels.get('com.docker.compose.network') != 'backend':
            raise ValueError()
        ipam = value['IPAM']
        if ipam.get('Driver') != 'default' or len(ipam['Config']) != 1: raise ValueError()
        subnet = ipaddress.ip_network(ipam['Config'][0]['Subnet'])
        gateway = ipaddress.ip_address(ipam['Config'][0]['Gateway'])
        if subnet.version != 4 or gateway not in subnet: raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise StageError('RETAINED_NETWORK_IDENTITY_INVALID') from None

def observe_peer(image):
    network = command(['/usr/bin/docker', 'network', 'create', '--driver', 'bridge',
        '--label', 'com.docker.compose.project=kinetra-production', '--label', 'com.docker.compose.network=backend', NETWORK], capture=True).strip()
    if not re.fullmatch(r'[a-f0-9]{64}', network): raise StageError('NETWORK_ID_INVALID')
    validate_network(network)
    configuration = b'''pid /tmp/nginx.pid;
worker_processes 1;
error_log /dev/stderr crit;
events { worker_connections 16; }
http {
  client_body_temp_path /tmp/client_body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  access_log off;
  server {
    listen 8080;
    location = /kinetra-stage-peer { default_type text/plain; return 200 "$remote_addr"; }
    location / { return 404; }
  }
}
'''
    container = None
    with tempfile.TemporaryDirectory(prefix='kinetra-peer-', dir='/run') as temporary:
        os.chmod(temporary, 0o755)
        config = pathlib.Path(temporary) / 'nginx.conf'
        write_new(config, configuration, 0o644)
        try:
            container = command(['/usr/bin/docker', 'create', '--name', 'kinetra-stage-peer', '--network', NETWORK,
                '--label', 'com.kinetra.stage=database-preparation', '--user', '101:101', '--read-only',
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32',
                '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.10',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,uid=101,gid=101,mode=0700',
                '--publish', '127.0.0.1:8080:8080', '--add-host', 'backend:127.0.0.1',
                '--mount', 'type=bind,source=' + str(config) + ',target=/etc/nginx/nginx.conf,readonly',
                image], capture=True).strip()
            if not re.fullmatch(r'[a-f0-9]{64}', container): raise StageError('DIAGNOSTIC_CONTAINER_ID_INVALID')
            command(['/usr/bin/docker', 'start', container])
            peer = None
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    with opener.open('http://127.0.0.1:8080/kinetra-stage-peer', timeout=2) as response:
                        body = response.read(65)
                        if response.status != 200 or len(body) > 64: raise StageError('PEER_RESPONSE_INVALID')
                        peer = str(ipaddress.ip_address(body.decode('ascii')))
                        break
                except (OSError, ValueError): time.sleep(0.25)
            if peer is None: raise StageError('DIAGNOSTIC_PEER_UNAVAILABLE')
        finally:
            if container is not None and re.fullmatch(r'[a-f0-9]{64}', container):
                command(['/usr/bin/docker', 'rm', '--force', '--volumes', container])
    validate_network(network)
    address = ipaddress.ip_address(peer)
    if address.is_unspecified or address.is_multicast: raise StageError('PEER_ADDRESS_INVALID')
    new_directory(EDGE, 0o755)
    body = 'set_real_ip_from ' + peer + ('/32' if address.version == 4 else '/128') + ';\nreal_ip_header X-Forwarded-For;\nreal_ip_recursive off;\n'
    write_new(EDGE / 'nginx-real-ip.conf', body.encode(), 0o644)
    return peer, network

def metadata_files(data):
    images = data['images']
    values = {key: images[key] for key in ('NODE_IMAGE', 'NGINX_IMAGE', 'BACKEND_IMAGE', 'FRONTEND_IMAGE')}
    values.update(VCS_REF=data['commit'], VITE_API_URL='https://80.68.156.131', VITE_PRIVATE_MEDIA_ORIGIN='',
        KINETRA_API_ENV_FILE=str(STAGE / 'env/api.env'), KINETRA_VIDEO_SCRATCH_DIR='')
    write_new(STAGE / 'env/production.env', ''.join(key + '=' + value + '\n' for key, value in values.items()).encode())
    values = {'POSTGRES_IMAGE': images['POSTGRES_IMAGE'], 'KINETRA_POSTGRES_DATA_DIR': str(STAGE / 'postgres/data'),
        'KINETRA_POSTGRES_CA_FILE': str(STAGE / 'tls/issued/public/ca.crt'),
        'KINETRA_POSTGRES_CERT_FILE': str(STAGE / 'tls/issued/public/server.crt'),
        'KINETRA_POSTGRES_KEY_FILE': str(STAGE / 'tls/issued/server-private/server.key'),
        'KINETRA_POSTGRES_SECRETS_DIR': str(STAGE / 'postgres/secrets'), 'KINETRA_EDGE_CONFIG_DIR': str(EDGE)}
    write_new(STAGE / 'env/single-server.env', ''.join(key + '=' + value + '\n' for key, value in values.items()).encode())

def validate_stage(image):
    # Never mount the whole stage or issued directory: the CA signing key stays
    # outside every container. Only needed paths and the individual leaf are read.
    mounts = [STAGE / 'source', STAGE / 'env', STAGE / 'postgres/data', STAGE / 'postgres/secrets',
        STAGE / 'tls/issued/public/ca.crt', STAGE / 'tls/issued/public/server.crt',
        STAGE / 'tls/issued/server-private/server.key', EDGE]
    args = ['--network', 'none', '--user', '0:0', '--read-only',
        '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges:true',
        '--pids-limit', '32', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.25']
    for path in mounts: args.extend(['--mount', 'type=bind,source=' + str(path) + ',target=' + str(path) + ',readonly'])
    arguments = ['node', str(STAGE / 'source/deploy/postgres/validate-single-server.mjs'),
        str(STAGE / 'env/single-server.env'), str(STAGE / 'env/production.env'), 'migrate', str(STAGE / 'env/jobs/migrate.env')]
    output = disposable_container(args, image, arguments, capture=True)
    if output.strip() != 'KINETRA_SINGLE_SERVER_CONFIG=VALIDATED_LOCAL (no service or required infrastructure gate executed)':
        raise StageError('STRICT_STAGE_VALIDATION_NOT_CONFIRMED')

def main():
    state = {'schema': 1, 'result': 'FAIL', 'stage': 'INPUT', 'error': None, 'commit': None,
        'observed_peer': None, 'network_id': None, 'registry_config_cleanup': 'NOT_NEEDED',
        'database_initialized': False, 'application_started': False}
    descriptor = None
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        raw = __import__('sys').stdin.buffer.read(1048577)
        if len(raw) > 1048576: raise StageError('PAYLOAD_TOO_LARGE')
        data = json.loads(raw)
        files = validate_payload(data)
        state['commit'] = data['commit']
        descriptor = os.open('/run/kinetra-database-stage.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        lock = os.fstat(descriptor)
        if not stat.S_ISREG(lock.st_mode) or lock.st_uid != 0 or lock.st_mode & 0o077: raise StageError('LOCK_FILE_UNSAFE')
        try: fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise StageError('DATABASE_STAGE_ALREADY_RUNNING') from None
        state['stage'] = 'HOST_PRECONDITIONS'
        preconditions()
        state['stage'] = 'SOURCE_STAGING'
        stage_sources(files)
        state['stage'] = 'IMAGES'
        state['registry_config_cleanup'] = 'PENDING'
        pull_images(data, state)
        if state['registry_config_cleanup'] != 'REMOVED': raise StageError('REGISTRY_CONFIG_CLEANUP_INCOMPLETE')
        state['stage'] = 'DATABASE_SECRETS_AND_TLS'
        create_database_secrets()
        state['stage'] = 'OBSERVED_EDGE_PEER'
        state['observed_peer'], state['network_id'] = observe_peer(data['images']['FRONTEND_IMAGE'])
        state['stage'] = 'STRICT_MIGRATE_FILE_VALIDATION'
        metadata_files(data)
        validate_stage(data['images']['BACKEND_IMAGE'])
        if any((STAGE / 'postgres/data').iterdir()): raise StageError('DATA_DIRECTORY_NO_LONGER_EMPTY')
        if command(['/usr/bin/docker', 'container', 'ls', '--all', '--quiet'], capture=True).strip(): raise StageError('TEMPORARY_CONTAINER_CLEANUP_INCOMPLETE')
        if command(['/usr/bin/docker', 'volume', 'ls', '--quiet'], capture=True).strip(): raise StageError('TEMPORARY_VOLUME_CLEANUP_INCOMPLETE')
        listeners = command(['/usr/bin/ss', '-H', '-lnt'], capture=True)
        if any(len(row.split()) >= 4 and row.split()[3].rsplit(':', 1)[-1] in {'5432', '8080'} for row in listeners.splitlines()):
            raise StageError('TEMPORARY_LISTENER_CLEANUP_INCOMPLETE')
        state['result'], state['stage'] = 'STAGED_ONLY', 'STAGING_COMPLETE'
        evidence = dict(state, images=data['images'], source_hashes={name: entry['sha256'] for name, entry in data['files'].items()})
        write_new(STAGE / 'evidence/stage.json', (json.dumps(evidence, sort_keys=True) + '\n').encode())
    except StageError as error: state['result'], state['error'] = 'FAIL', str(error)
    except BaseException: state['result'], state['error'] = 'FAIL', 'UNEXPECTED_ERROR_PARTIAL_STATE_PRESERVED'
    finally:
        if descriptor is not None: os.close(descriptor)
        print(json.dumps(state, sort_keys=True), flush=True)
    return 0 if state['result'] == 'STAGED_ONLY' else 1

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    raise SystemExit(main())
"""


def validate_stage_result(raw):
    try:
        data = json.loads(raw)
    except Exception:
        raise Error("REMOTE_RESULT_INVALID") from None
    keys = {"schema", "result", "stage", "error", "commit", "observed_peer", "network_id", "registry_config_cleanup", "database_initialized", "application_started"}
    if not isinstance(data, dict) or set(data) != keys or data["schema"] != 1:
        raise Error("REMOTE_RESULT_INVALID")
    if data["result"] not in {"FAIL", "STAGED_ONLY"} or data["database_initialized"] is not False or data["application_started"] is not False:
        raise Error("REMOTE_RESULT_INVALID")
    if not isinstance(data["stage"], str) or not re.fullmatch(r"[A-Z_]{1,64}", data["stage"]) or (data["error"] is not None and (not isinstance(data["error"], str) or not re.fullmatch(r"[A-Z_]{1,80}", data["error"]))):
        raise Error("REMOTE_RESULT_INVALID")
    if data["commit"] is not None and (not isinstance(data["commit"], str) or not re.fullmatch(r"[a-f0-9]{40}", data["commit"])): raise Error("REMOTE_RESULT_INVALID")
    if data["network_id"] is not None and (not isinstance(data["network_id"], str) or not re.fullmatch(r"[a-f0-9]{64}", data["network_id"])): raise Error("REMOTE_RESULT_INVALID")
    if data["observed_peer"] is not None:
        try: ipaddress.ip_address(data["observed_peer"])
        except Exception: raise Error("REMOTE_RESULT_INVALID") from None
    if data["registry_config_cleanup"] not in {"NOT_NEEDED", "PENDING", "REMOVED", "FAILED"}: raise Error("REMOTE_RESULT_INVALID")
    if data["result"] == "STAGED_ONLY" and (data["stage"] != "STAGING_COMPLETE" or data["error"] is not None or data["commit"] is None or data["network_id"] is None or data["observed_peer"] is None or data["registry_config_cleanup"] != "REMOVED"):
        raise Error("REMOTE_PASS_EVIDENCE_INCOMPLETE")
    return data


def emit(state):
    print("TIMEWEB_DATABASE_STAGE=" + json.dumps(state, sort_keys=True), flush=True)


def main(argv=None, environ=None, api_factory=inspection.Api):
    argv = sys.argv[1:] if argv is None else argv
    environ = os.environ if environ is None else environ
    state = {"result": "IN_PROGRESS", "server_id": inspection.SERVER_ID, "public_ipv4": inspection.PUBLIC_IPV4,
        "host_key_fingerprint": None, "server_status": "UNKNOWN", "ssh_key_id": None,
        "guest_key_cleanup": "NOT_NEEDED", "account_key_cleanup": "NOT_NEEDED", "local_key_cleanup": "NOT_NEEDED",
        "staging": None, "error": None, "application_readiness": "BLOCKED_MISSING_PROVIDER_INPUTS"}
    api, folder, data, payload = None, None, None, b""
    try:
        if argv != ["--stage-new-empty-database-host"]: raise Error("EXPLICIT_DATABASE_STAGE_FLAG_REQUIRED")
        if environ.get("GITHUB_ACTIONS") != "true" or environ.get("GITHUB_REPOSITORY") != inspection.REPOSITORY or environ.get("GITHUB_RUN_ATTEMPT") != "1":
            raise Error("AUTHORIZED_NEW_GITHUB_RUN_REQUIRED")
        run_id = environ.get("GITHUB_RUN_ID", "")
        if not re.fullmatch(r"[1-9][0-9]{0,19}", run_id): raise Error("SUPPLIED_RUN_ID_INVALID")
        if environ.get("ROOT_SUPPLIED_SERVER_ID", str(inspection.SERVER_ID)) != str(inspection.SERVER_ID) or environ.get("ROOT_SUPPLIED_SERVER_IP", inspection.PUBLIC_IPV4) != inspection.PUBLIC_IPV4:
            raise Error("CONFIRMED_SERVER_OVERRIDE_REFUSED")
        runtime_temp = Path(environ.get("RUNNER_TEMP", ""))
        if not runtime_temp.is_absolute() or not runtime_temp.is_dir(): raise Error("RUNNER_TEMP_INVALID")
        token = environ.pop("TIMEWEB_CLOUD_TOKEN", "")
        registry_token = environ.pop("GITHUB_TOKEN", "")
        if not token or len(token) > 16384 or any(c.isspace() for c in token): raise Error("TIMEWEB_SECRET_MISSING_OR_INVALID")
        if not 10 <= len(registry_token) <= 16384 or any(c.isspace() for c in registry_token): raise Error("REGISTRY_TOKEN_MISSING_OR_INVALID")
        data = metadata(environ)
        data["files"] = source_bundle(environ.get("APP_CHECKOUT", ""), data["commit"])
        data["registry_token"] = registry_token
        del registry_token
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        deadline = time.monotonic() + PREPARE_SECONDS
        api = api_factory(token, inspection.SERVER_ID, deadline)
        del token
        state.update(inspection.validate_server(api.request("GET", f"/servers/{inspection.SERVER_ID}"), inspection.SERVER_ID, inspection.PUBLIC_IPV4))
        if state["server_status"] != "on": raise Error("EXISTING_SERVER_NOT_ON")
        api.server_verified = True
        folder = Path(tempfile.mkdtemp(prefix="kinetra-db-stage-", dir=runtime_temp))
        os.chmod(folder, 0o700)
        state["local_key_cleanup"] = "PENDING"
        known_hosts, fingerprint = inspection.pin_host_key(inspection.PUBLIC_IPV4, folder, deadline)
        state["host_key_fingerprint"] = fingerprint
        if fingerprint != PINNED_FINGERPRINT: raise Error("PINNED_HOST_KEY_MISMATCH")
        private, public_key = inspection.prepare_key(folder, deadline)
        name = "kinetra-db-stage-" + run_id
        key = inspection.ssh_key_object(api.request("POST", "/ssh-keys", {"name": name, "body": public_key, "is_default": False}))
        key_id = inspection.positive_id(key.get("id"))
        state["ssh_key_id"] = key_id
        if key.get("name") != name or key.get("body") != public_key or key.get("is_default") is not False:
            # An API response naming a different key is not deletion authority.
            # Existing cleanup records UNVERIFIED_KEY_RECONCILE without DELETE.
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
        if code != 0: raise Error("PRE_STAGE_INSPECTION_FAILED")
        bootstrap.require_inspected_guest(output, after=True)
        if deadline - time.monotonic() < REMOTE_SECONDS + 180: raise Error("INSUFFICIENT_STAGE_AND_CLEANUP_TIME")
        command = "/usr/bin/timeout --signal=TERM --kill-after=15s " + str(REMOTE_SECONDS) + "s /usr/bin/python3 -c " + shlex.quote(GUEST_PREPARE)
        payload = json.dumps(data, allow_nan=False).encode()
        code, output, _ = run_with_input(arguments + [command], payload, REMOTE_SECONDS + 30)
        data.pop("registry_token", None)
        payload = b""
        state["staging"] = validate_stage_result(output)
        if state["staging"]["commit"] != data["commit"]: raise Error("REMOTE_SOURCE_COMMIT_MISMATCH")
        if code != 0 or state["staging"]["result"] != "STAGED_ONLY": raise Error("REMOTE_STAGE_FAILED_PARTIAL_STATE_PRESERVED")
        state["result"] = "PASS_STAGING_ONLY_DATABASE_NOT_STARTED"
    except Error as error: state["result"], state["error"] = "FAIL", str(error)
    except BaseException: state["result"], state["error"] = "FAIL", "UNEXPECTED_ERROR_PARTIAL_STATE_POSSIBLE"
    finally:
        if data is not None: data.pop("registry_token", None)
        payload = b""
        inspection.cleanup(api, folder, state)
        if any(state[key] not in {"NOT_NEEDED", "API_DELETE_CONFIRMED", "ALREADY_ABSENT", "REMOVED"} for key in ("guest_key_cleanup", "account_key_cleanup", "local_key_cleanup")):
            state["result"], state["error"] = "FAIL", state["error"] or "KEY_CLEANUP_REQUIRES_RECONCILIATION"
        emit(state)
    return 0 if state["result"] == "PASS_STAGING_ONLY_DATABASE_NOT_STARTED" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, inspection.interrupted)
    signal.signal(signal.SIGINT, inspection.interrupted)
    sys.exit(main())
