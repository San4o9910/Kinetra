#!/usr/bin/env python3
"""Read-only immutable launch gate, extracted unchanged from the dormant DB workflow.

No host/provider operations. Every original assertion is retained. Returned
GitHub readers are reused only to authenticate the prior database handoff.
"""


def verify_source_and_images():
    import base64, hashlib, io, json, os, re, urllib.error, urllib.parse, urllib.request, zipfile
    from datetime import datetime, timezone
    repo = 'San4o9910/Kinetra'
    env = os.environ
    app, base, merge = [env[name] for name in ('APPROVED_APP_COMMIT', 'APPROVED_BASE_COMMIT', 'APPROVED_MERGE_COMMIT')]
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, file, code, message, headers, new_url): return None
    opener = urllib.request.build_opener(NoRedirect)
    def api(path, *, archive=False):
        request = urllib.request.Request('https://api.github.com/repos/' + repo + path,
            headers={'Authorization': 'Bearer ' + env['GH_TOKEN'], 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'})
        try:
            response = opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            if not archive or error.code != 302: raise
            location = error.headers['Location']; url = urllib.parse.urlsplit(location)
            assert url.scheme == 'https' and not url.username and not url.password and url.port in (None, 443)
            assert url.hostname and url.hostname.endswith(('.blob.core.windows.net', '.actions.githubusercontent.com'))
            # The signed artifact URL receives no GitHub bearer header.
            response = opener.open(urllib.request.Request(location), timeout=30)
        with response:
            limit = 64 * 1024 * 1024 if archive else 4 * 1024 * 1024
            body = response.read(limit + 1)
        assert len(body) <= limit
        return body if archive else json.loads(body)
    def successful_run(run_id, path, sha, event):
        run = api('/actions/runs/' + str(run_id))
        assert run['repository']['full_name'] == repo and run['head_sha'] == sha and run['event'] == event
        assert run['path'] == path and run['status'] == 'completed' and run['conclusion'] == 'success'
        assert run['run_attempt'] == 1, 'Only the reviewed first attempt is authorized'
        jobs = api('/actions/runs/' + str(run_id) + '/attempts/1/jobs?per_page=100')
        assert jobs['total_count'] == len(jobs['jobs']) and jobs['jobs']
        for job in jobs['jobs']:
            assert job['status'] == 'completed' and job['conclusion'] == 'success'
            assert job['steps'] and all(step['status'] == 'completed' and step['conclusion'] == 'success' for step in job['steps'])
        return run, jobs['jobs']
    image_run, image_jobs = successful_run(env['APPROVED_IMAGE_RUN'], '.github/workflows/kinetra-image-validation.yml',
        env['APPROVED_IMAGE_CONTROL_COMMIT'], 'push')
    assert image_run['head_branch'] == 'ops/timeweb-hourly-preflight-20260909'
    assert len(image_jobs) == 1 and image_jobs[0]['name'] == 'qualify'
    assert 'Publish qualified images to project GHCR packages when enabled' in {step['name'] for step in image_jobs[0]['steps']}
    assert 'Verify upstream source coverage with independent CPE matching' in {step['name'] for step in image_jobs[0]['steps']}
    source = api('/contents/.github/workflows/kinetra-image-validation.yml?ref=' + env['APPROVED_IMAGE_CONTROL_COMMIT'])
    assert source['type'] == 'file' and source['encoding'] == 'base64'
    workflow = base64.b64decode(source['content'])
    assert hashlib.sha256(workflow).hexdigest() == env['APPROVED_IMAGE_WORKFLOW_SHA256']
    # This reviewed workflow already checked actual checkout SHA/semantics in every CI job log.
    # Reuse its immutable artifact, and recheck current PR/run state below instead of duplicating that parser.
    artifact = api('/actions/artifacts/' + env['APPROVED_IMAGE_ARTIFACT_ID'])
    assert artifact['id'] == int(env['APPROVED_IMAGE_ARTIFACT_ID']) and artifact['expired'] is False
    assert artifact['name'] == 'kinetra-image-evidence-' + env['APPROVED_IMAGE_RUN'] + '-1'
    assert artifact['workflow_run']['id'] == int(env['APPROVED_IMAGE_RUN'])
    assert artifact['workflow_run']['head_sha'] == env['APPROVED_IMAGE_CONTROL_COMMIT']
    assert artifact['digest'] == 'sha256:' + env['APPROVED_IMAGE_ARTIFACT_SHA256']
    assert 0 < artifact['size_in_bytes'] <= 64 * 1024 * 1024
    archive = api('/actions/artifacts/' + env['APPROVED_IMAGE_ARTIFACT_ID'] + '/zip', archive=True)
    assert hashlib.sha256(archive).hexdigest() == env['APPROVED_IMAGE_ARTIFACT_SHA256']
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        names = zipped.namelist()
        assert len(names) == len(set(names)) and len(names) <= 150
        def member(name):
            info = zipped.getinfo(name)
            assert not info.is_dir() and not info.flag_bits & 1 and info.file_size <= 4 * 1024 * 1024
            return zipped.read(info)
        gates = json.loads(member('source-gates.json'))
        assert gates['repository'] == repo
        assert (gates['app_commit'], gates['base_commit'], gates['merge_commit']) == (app, base, merge)
        assert len(gates['runs']) == 2
        pr = api('/pulls/21')
        assert pr['state'] == 'open' and pr['draft'] and not pr['merged']
        assert pr['head']['repo']['full_name'] == repo and pr['head']['ref'] == 'feature/onboarding-exploration-mode'
        assert (pr['head']['sha'], pr['base']['sha'], pr['merge_commit_sha']) == (app, base, merge)
        assert [parent['sha'] for parent in api('/commits/' + merge)['parents']] == [base, app]
        expected_names = {'Lint, Typecheck & Build', 'Unit & E2E Tests', 'Structure Verification'}
        for kind, variable, event, semantics, checkout in (
            ('exact-head', 'APPROVED_HEAD_RUN', 'push', 'push-head', app),
            ('merge-ref', 'APPROVED_MERGE_RUN', 'pull_request', 'pull-request-merge', merge)):
            records = [record for record in gates['runs'] if record['kind'] == kind]
            assert len(records) == 1
            recorded = records[0]
            assert recorded['id'] == int(env[variable]) and recorded['attempt'] == 1
            run, jobs = successful_run(env[variable], '.github/workflows/ci.yml', app, event)
            if event == 'pull_request':
                assert any(item['number'] == 21 and item['head']['sha'] == app and item['base']['sha'] == base for item in run['pull_requests'])
            assert len(jobs) == 3 and {job['name'] for job in jobs} == expected_names
            assert len(recorded['jobs']) == 3 and {job['name'] for job in recorded['jobs']} == expected_names
            assert {(job['id'], job['name']) for job in recorded['jobs']} == {(job['id'], job['name']) for job in jobs}
            assert all(job['semantics'] == semantics and job['checkout'] == checkout for job in recorded['jobs'])
        assert member('qualification.txt') == b'KINETRA_IMAGE_SCAN_HIGH_CRITICAL=PASS\n'
        runtime_markers = member('backend-application-smoke.txt').decode('ascii').splitlines()
        assert len(runtime_markers) == 4
        assert runtime_markers[0] == 'KINETRA_FINAL_NODE_SHARED_PATCHED_OPENSSL=PASS'
        assert runtime_markers[2:] == ['KINETRA_FINAL_IMAGE_BCRYPT_AND_PHOTO_NORMALIZATION=PASS',
                                      'KINETRA_FINAL_IMAGE_MP4_H264_AAC=PASS']
        node_smoke = json.loads(runtime_markers[1])
        node_runtime = json.loads(member('node-runtime-verification.json'))
        assert node_runtime.pop('finalRuntimeLinkage') == node_smoke['runtimeLinkage']
        assert node_smoke['nodeBuild'] == node_runtime and node_runtime['schemaVersion'] == 1
        assert node_runtime['runtime']['versions']['node'] == '22.23.2'
        assert node_runtime['runtime']['versions']['modules'] == '127'
        assert node_runtime['runtime']['node_shared_openssl'] is True
        openssl = re.fullmatch(r'3\.5\.(\d+)', node_runtime['runtime']['versions']['openssl'])
        assert openssl and int(openssl[1]) >= 8
        assert re.fullmatch(r'[a-f0-9]{64}', node_runtime['binarySha256'])
        assert node_runtime['sourceSha256'] == 'bbe768df8d5815d7fa76124052985332452e0a4742d39f32027550d1aab8f6fb'
        assert isinstance(node_runtime['configure'], list) and '--shared-openssl' in node_runtime['configure']
        for linkage in (node_runtime['linkage']['ldd'], node_smoke['runtimeLinkage']):
            assert isinstance(linkage, str) and not re.search(r'not found|Error loading shared library|Error relocating', linkage)
            for library in ('libssl.so.3', 'libcrypto.so.3'):
                assert re.search(r'^\s*' + re.escape(library) + r'\s+=>\s+/usr/lib/' + re.escape(library) + r'\s+\(', linkage, re.M)
        inventory = json.loads(member('media-source-verification.json'))
        assert inventory['result'] == 'KINETRA_SOURCE_MEDIA_INVENTORY=PASS'
        source_components = json.loads(member('source-components.cdx.json'))
        assert inventory['source_components'] == source_components
        assert source_components['bomFormat'] == 'CycloneDX' and source_components['specVersion'] == '1.6'
        assert len(source_components['components']) == 2
        assert {component['name'] for component in source_components['components']} == {'ffmpeg', 'imagemagick'}
        assert inventory['source_builds']['schemaVersion'] == 1
        assert len(inventory['source_builds']['components']) == 2
        assert {component['name'] for component in inventory['source_builds']['components']} == {'ffmpeg', 'imagemagick'}
        assert inventory['media_apk_inventory'] and inventory['runtime_apk_inventory'].strip()
        summary = json.loads(member('scan-summary.json'))
        assert summary['scanner_step_outcome'] == 'success' and summary['errors'] == []
        assert len(summary['images']) == 2 and {item['image'] for item in summary['images']} == {'backend', 'frontend'}
        assert all(item['vulnerability_count'] == 0 and item['secret_count'] == 0 for item in summary['images'])
        assert member('scanner-cleanup.status').strip() == b'0'
        published = member('published-images.env').decode('ascii').splitlines()
        assert len(published) == 2 and set(published) == {'BACKEND_IMAGE=' + env['BACKEND_IMAGE'], 'FRONTEND_IMAGE=' + env['FRONTEND_IMAGE']}
        registry_inputs = [line.split('\t') for line in member('registry-inputs.tsv').decode('ascii').splitlines()]
        assert len(registry_inputs) == 4 and all(len(row) == 3 for row in registry_inputs)
        assert {row[0] for row in registry_inputs} == {'NODE_IMAGE', 'NGINX_IMAGE', 'TRIVY_IMAGE', 'GRYPE_IMAGE'}
        assert all(row[2] == env[row[0]] for row in registry_inputs if row[0] in ('NODE_IMAGE', 'NGINX_IMAGE'))
        registry_tags = {row[0]: row[1] for row in registry_inputs}
        assert registry_tags['NODE_IMAGE'] == 'docker.io/library/node:22-alpine3.24'
        assert registry_tags['NGINX_IMAGE'] == 'docker.io/nginxinc/nginx-unprivileged:1.30.4-alpine-slim'
        node_version = member('node-base-version.txt').decode('ascii')
        nginx_version = member('nginx-base-version.txt').decode('ascii')
        assert len(re.findall(r'^v22\.\d+\.\d+$', node_version, re.M)) == 1
        assert len(re.findall(r'^nginx version: nginx/1\.30\.4$', nginx_version, re.M)) == 1
        for version_evidence in (node_version, nginx_version):
            assert re.search(r'^ID=alpine$', version_evidence, re.M)
            assert re.search(r'^VERSION_ID=3\.24\.\d+$', version_evidence, re.M)
        registry_images = {row[0]: row[2] for row in registry_inputs}
        assert re.fullmatch(r'(?:docker.io/)?anchore/grype@sha256:[a-f0-9]{64}', registry_images['GRYPE_IMAGE'])
        upstream = json.loads(member('upstream-media/summary.json'))
        assert upstream['result'] == 'PASS' and not upstream.get('failure')
        assert upstream['scanner'] == '0.118.0' and upstream['scanner_image'] == registry_images['GRYPE_IMAGE']
        assert upstream['source_sbom_sha256'] == hashlib.sha256(member('source-components.cdx.json')).hexdigest()
        component_versions = {component['name']: component['version'] for component in source_components['components']}
        assert upstream['components'] == component_versions
        assert {component['name']: component['version'] for component in inventory['source_builds']['components']} == component_versions
        database = upstream['database']
        assert re.fullmatch(r'[a-f0-9]{64}', database['sha256'])
        db_status = json.loads(member('upstream-media/db-status.stdout'))
        assert db_status['valid'] is True and not db_status.get('error')
        assert re.fullmatch(r'6(?:\.\d+){0,2}', db_status['schemaVersion'])
        assert db_status['from'].startswith('https://grype.anchore.io/')
        assert all(database[key] == db_status[key] for key in ('schemaVersion', 'built', 'from'))
        built = datetime.fromisoformat(database['built'].replace('Z', '+00:00'))
        assert built.tzinfo is not None
        assert -300 <= (datetime.now(timezone.utc) - built).total_seconds() <= 120 * 3600
        expected_calls = [('version', 0, False), ('db-update', 0, True), ('db-status', 0, False),
                          ('positive-control', 2, False), ('production', 0, False)]
        assert [(call['phase'], call['exit_code'], call['network']) for call in upstream['calls']] == expected_calls
        assert upstream['positive-control']['exit_code'] == 2 and upstream['production']['exit_code'] == 0
        assert upstream['high_critical_findings'] == 0
        for phase, expected_coverage in (('positive-control', {'ffmpeg': '5.1.9', 'imagemagick': '7.1.2-29'}),
                                         ('production', component_versions)):
            assert upstream[phase]['result'] == 'PASS' and upstream[phase]['network'] == 'none'
            assert upstream[phase]['coverage'] == expected_coverage
            assert upstream[phase]['database_sha256'] == database['sha256']
        controls = upstream['positive-control']['findings']
        assert any(finding['severity'] in ('High', 'Critical') for finding in controls)
        for name, version, cves in (
            ('ffmpeg', '5.1.9', {'CVE-2026-8461'}),
            ('imagemagick', '7.1.2-29', {'CVE-2026-86420', 'CVE-2026-86421'})):
            assert cves <= {finding['id'] for finding in controls if finding['component'] == name and finding['version'] == version}
        findings = upstream['production']['findings']
        assert isinstance(findings, list)
        assert all(finding['component'] in component_versions and finding['version'] == component_versions[finding['component']]
                   and finding['severity'] in ('Unknown', 'Negligible', 'Low', 'Medium') for finding in findings)
        production = json.loads(member('upstream-media/production.json'))
        assert production['descriptor']['name'] == 'grype' and production['descriptor']['version'] == upstream['scanner']
        assert all(production['descriptor']['db'][key] == database[key] for key in ('schemaVersion', 'built', 'from'))
        assert isinstance(production['matches'], list) and len(production['matches']) == len(findings)
        assert not production.get('ignoredMatches')
        assert all(match['vulnerability']['severity'] in ('Unknown', 'Negligible', 'Low', 'Medium') for match in production['matches'])
        scanned_bom = json.loads(member('upstream-media/production.cdx.json'))
        assert scanned_bom['bomFormat'] == 'CycloneDX' and scanned_bom['specVersion'] == '1.7'
        assert len(scanned_bom['components']) == 2
        assert {component['name']: component['version'] for component in scanned_bom['components']} == component_versions
        expected_components = {component['name']: component for component in source_components['components']}
        for component in scanned_bom['components']:
            expected = expected_components[component['name']]
            assert component['purl'] == expected['purl']
            assert component['cpe'].replace('\\-', '-') == expected['cpe']
        for target in ('backend', 'frontend'):
            raw_manifest = member(target + '-registry-manifest.json')
            assert 'sha256:' + hashlib.sha256(raw_manifest).hexdigest() == env[target.upper() + '_IMAGE'].split('@')[1]
            manifest = json.loads(raw_manifest)
            images = json.loads(member(target + '-image.json'))
            assert len(images) == 1 and manifest['config']['digest'] == images[0]['Id']
            assert images[0]['Config']['Labels']['org.opencontainers.image.revision'] == app
            assert images[0]['Os'] == 'linux' and images[0]['Architecture'] == 'amd64'
    # Live package metadata must still identify private packages owned by this project.
    for target in ('backend', 'frontend'):
        request = urllib.request.Request('https://api.github.com/users/San4o9910/packages/container/kinetra-' + target,
            headers={'Authorization': 'Bearer ' + env['GH_TOKEN'], 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'})
        with opener.open(request, timeout=30) as response:
            body = response.read(1024 * 1024 + 1)
        assert len(body) <= 1024 * 1024
        package = json.loads(body)
        assert package['visibility'] == 'private' and package['repository']['full_name'] == repo
    print('KINETRA_DATABASE_SOURCE_AND_IMAGE_PROVENANCE=PASS')
    return api, successful_run


if __name__ == "__main__":
    import sys
    try:
        verify_source_and_images()
    except BaseException:
        # Never expose credential-bearing signed artifact URLs in a traceback.
        print("KINETRA_LAUNCH_PROVENANCE=FAIL", file=sys.stderr)
        sys.exit(1)
