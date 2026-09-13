#!/usr/bin/env python3
"""Offline boundaries for a dormant, exact-qualified-shell acceptance proposal.

Applies only to temporary files. No network, Docker or host access. The synthetic
HTTP document uses actual inspected references, with an explicitly substituted
fixture hash. The production literals must match the independent host evidence.
"""
import ast
import copy
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).parent
EVIDENCE = json.loads((ROOT / 'local-asset-inspection-20260913.json').read_text())
ASSETS = EVIDENCE['inspection']['frontend_assets']
THEME = (ROOT / 'qualified-theme-init-20260913.js').read_bytes()
SHELL = '\n'.join('<script src="'+html.escape(r['url'],quote=True)+'"></script>' if r['kind']=='script'
                  else '<link rel="stylesheet" href="'+html.escape(r['url'],quote=True)+'">'
                  for r in ASSETS['references']).encode()
SHA = lambda data: hashlib.sha256(data).hexdigest()
BEFORE = {'start-application-host.py':'e7954b99525f9a66f174d4c4729f0c6287b11f3c8cb2432106e4283d87d6e9e4',
          'activate-https-host.py':'3245b2d3cb1f5bf30265dce6f62d2cfa1545bd4dd1fbf1b51288c6d8fb726d2e'}
AFTER = {'start-application-host.py':'8de4fdccd73c8c1d5666fa46806d47125f0aec49e73c6f4a1bf00db36584427d',
         'activate-https-host.py':'fa57da54c304254889a92c7960fa31a4a133d531012549e88f6146095ac60de5'}


class Rejected(Exception): pass


def require(ok, reason):
    if not ok: raise Rejected(reason)


def isolated(source, names):
    nodes=[n for n in ast.parse(source).body if (isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names)
           or (isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id.startswith(('QUALIFIED_','BLOCKED_')) for t in n.targets))]
    scope={'require':require,'sha256':SHA,'re':re,'json':json,'HTMLParser':HTMLParser}
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'<isolated-asset-proposal>','exec'),scope)
    return scope


class AssetPolicyProposal(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before={name:(ROOT/name).read_text() for name in BEFORE}
        with tempfile.TemporaryDirectory() as folder:
            dest=Path(folder)/'ops/timeweb';dest.mkdir(parents=True)
            for name,content in cls.before.items(): (dest/name).write_text(content)
            subprocess.run(['git','apply','--check',str((ROOT/'local-asset-policy-fix-20260913.patch').resolve())],cwd=folder,check=True,capture_output=True)
            subprocess.run(['git','apply',str((ROOT/'local-asset-policy-fix-20260913.patch').resolve())],cwd=folder,check=True,capture_output=True)
            cls.after={name:(dest/name).read_text() for name in BEFORE}

    def setUp(self):
        self.scope=isolated(self.after['start-application-host.py'],{'Assets','local_acceptance'})
        # The whole real document was hashed on the host; it is not claimed to be
        # this synthetic reconstruction. Substitute its hash only in this fixture.
        self.scope['QUALIFIED_SHELL_SHA256']=SHA(SHELL)
        self.responses={
            '/':(200,{'content-type':'text/html','x-content-type-options':'nosniff','x-frame-options':'DENY',
                       'referrer-policy':'no-referrer','content-security-policy':ASSETS['csp']},SHELL),
            '/theme-init.js':(200,{'content-type':'application/javascript'},THEME),
            '/assets/index-BWzIO3Fz.js':(200,{'content-type':'application/javascript'},b'fixture bundled JS'),
            '/assets/index-BUHqTTi2.css':(200,{'content-type':'text/css'},b'fixture bundled CSS'),
            '/health':(200,{'content-type':'application/json'},b'{"status":"ok"}'),
            '/ready':(404,{},b'not found'),
            '/api/v1/me':(401,{'cache-control':'no-store'},b'unauthorized')}
        self.calls=[]
        def get(path):
            self.assertTrue(path.startswith('/') and not path.startswith('//'))
            self.calls.append(path)
            return self.responses[path]
        self.scope['local_get']=get

    def test_01_exact_patch_and_frozen_identities(self):
        for name in BEFORE:
            self.assertEqual(SHA(self.before[name].encode()),BEFORE[name])
            self.assertEqual(SHA(self.after[name].encode()),AFTER[name])

    def test_02_no_unrelated_executable_change(self):
        allowed={'start-application-host.py':{'Assets','local_acceptance'},'activate-https-host.py':{'public_acceptance'}}
        for name in BEFORE:
            def frozen(src):
                return [ast.dump(n) for n in ast.parse(src).body
                        if not ((isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in allowed[name])
                        or (isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id.startswith(('QUALIFIED_','BLOCKED_')) for t in n.targets)))]
            self.assertEqual(frozen(self.before[name]),frozen(self.after[name]))

    def test_03_original_acceptance_assertions_retained(self):
        for name,fn in [('start-application-host.py','local_acceptance'),('activate-https-host.py','public_acceptance')]:
            def assertions(src):
                node=next(n for n in ast.parse(src).body if isinstance(n,ast.FunctionDef) and n.name==fn)
                return {ast.dump(n) for n in ast.walk(node) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='require'}
            self.assertLessEqual(assertions(self.before[name]),assertions(self.after[name]))

    def test_04_real_evidence_bindings_and_theme_match(self):
        s=isolated(self.after['start-application-host.py'],{'Assets'})
        self.assertEqual(s['QUALIFIED_SHELL_SHA256'],ASSETS['index_sha256'])
        self.assertEqual(s['QUALIFIED_THEME_SHA256'],ASSETS['theme_sha256'])
        self.assertEqual(SHA(THEME),ASSETS['theme_sha256'])
        self.assertEqual(s['QUALIFIED_CSP'],ASSETS['csp'])
        self.assertEqual(s['BLOCKED_FONT_STYLESHEET'],ASSETS['references'][0]['url'])
        self.assertEqual(EVIDENCE['result'],'PASS_READ_ONLY_HOST_MONITORING_INSPECTION')
        self.assertEqual(EVIDENCE['account_key_cleanup'],'API_DELETE_CONFIRMED')
        self.assertEqual(EVIDENCE['guest_key_cleanup'],'API_DELETE_CONFIRMED')
        self.assertEqual(EVIDENCE['local_key_cleanup'],'REMOVED')

    def test_05_actual_references_reproduce_original_failure(self):
        old=isolated(self.before['start-application-host.py'],{'Assets'})
        with self.assertRaisesRegex(Rejected,'UNREVIEWED_ASSET_ORIGIN'):old['Assets']().feed(SHELL.decode())
        with self.assertRaisesRegex(Rejected,'UNREVIEWED_ASSET_ORIGIN'):old['Assets']().feed('<script src="/theme-init.js"></script>')

    def test_06_complete_local_http_fixture_passes_without_external_fetch(self):
        result=self.scope['local_acceptance']()
        self.assertEqual(set(result),set(self.responses))
        self.assertEqual(set(self.calls),set(self.responses))
        self.assertEqual(result['/theme-init.js']['sha256'],ASSETS['theme_sha256'])

    def test_07_changed_document_stops_before_asset_fetch(self):
        status,headers,body=self.responses['/'];self.responses['/']=(status,headers,body+b' ')
        with self.assertRaisesRegex(Rejected,'QUALIFIED_SHELL_CHANGED'):self.scope['local_acceptance']()
        self.assertEqual(self.calls,['/'])

    def test_08_changed_theme_rejected(self):
        self.responses['/theme-init.js']=(200,{'content-type':'application/javascript'},THEME+b' ')
        with self.assertRaisesRegex(Rejected,'QUALIFIED_THEME_CHANGED'):self.scope['local_acceptance']()

    def test_09_csp_overrides_and_external_permissions_rejected(self):
        base=ASSETS['csp']
        cases=[base+"; style-src-elem https:",base+"; style-src 'self'",base.replace("font-src 'self'","font-src https:"),
               base.replace("style-src 'self' 'unsafe-inline'","style-src 'self' 'unsafe-inline' https://fonts.googleapis.com")]
        for csp in cases:
            with self.subTest(csp=csp),self.assertRaisesRegex(Rejected,'QUALIFIED_ASSET_CSP_CHANGED'):
                self.scope['Assets'](csp,SHELL)

    def test_10_unknown_assets_and_disguised_theme_rejected(self):
        for tag in ['<script src="https://foreign.invalid/a.js"></script>', '<script src="//evil.invalid/a.js"></script>',
                    '<script src="/theme-init.js?v=1"></script>', '<link rel="stylesheet" href="/theme-init.js">',
                    '<script src="/assets/../escape.js"></script>', '<script src="/assets/%2e%2e/a.js"></script>',
                    '<link rel="stylesheet" href="https://fonts.googleapis.com/changed">',
                    '<script src="'+html.escape(ASSETS['references'][0]['url'],quote=True)+'"></script>']:
            with self.subTest(tag=tag),self.assertRaisesRegex(Rejected,'UNREVIEWED_ASSET_ORIGIN'):
                self.scope['Assets'](ASSETS['csp'],SHELL).feed(tag)

    def test_11_known_blocked_font_never_counts_as_asset(self):
        parser=self.scope['Assets'](ASSETS['csp'],SHELL);parser.feed(SHELL.decode());parser.verify_complete()
        self.assertEqual(parser.blocked_font_links,1)
        self.assertEqual(parser.paths,{'/theme-init.js','/assets/index-BWzIO3Fz.js','/assets/index-BUHqTTi2.css'})
        with self.assertRaisesRegex(Rejected,'DUPLICATE_BLOCKED_FONT_LINK'):parser.feed(SHELL.decode())

    def test_12_theme_cannot_replace_required_bundled_js_or_css(self):
        for missing in ['/assets/index-BWzIO3Fz.js','/assets/index-BUHqTTi2.css']:
            parser=self.scope['Assets'](ASSETS['csp'],SHELL);parser.feed(SHELL.decode());parser.paths.remove(missing)
            with self.assertRaisesRegex(Rejected,'REAL_BUILT_ASSETS_REQUIRED'):parser.verify_complete()

    def test_13_api_boundary_cookie_and_no_store_still_required(self):
        for response in [(200,{'cache-control':'no-store'},b'wrong status'),(401,{},b'no cache control'),
                         (401,{'cache-control':'no-store','set-cookie':'fixture'},b'cookie')]:
            with self.subTest(response=response):
                self.responses['/api/v1/me']=response
                with self.assertRaises(Rejected):self.scope['local_acceptance']()

    def test_14_html_in_asset_response_rejected(self):
        for path in ['/theme-init.js','/assets/index-BWzIO3Fz.js']:
            with self.subTest(path=path):
                old=self.responses[path];self.responses[path]=(200,{'content-type':'text/html'},b'<html>fallback</html>')
                with self.assertRaisesRegex(Rejected,'LOCAL_BUILT_ASSET_FAILED'):self.scope['local_acceptance']()
                self.responses[path]=old

    def https_scope(self):
        scope=isolated(self.after['activate-https-host.py'],{'public_acceptance'})
        cert={'trusted':True,'ip_san':'80.68.156.131'}
        def get(path):return (*self.responses[path],cert)
        class Connection:
            def __init__(self,*a,**k):pass
            def request(self,*a,**k):pass
            def getresponse(self):
                return SimpleNamespace(status=308,getheader=lambda key:{'Location':'https://80.68.156.131/'}.get(key))
            def close(self):pass
        scope.update(local=SimpleNamespace(**self.scope),PUBLIC_IP='80.68.156.131',ORIGIN='https://80.68.156.131',
                     wait_for_certificate=lambda:get('/'),https_get=get,http=SimpleNamespace(client=SimpleNamespace(HTTPConnection=Connection)))
        return scope

    def test_15_https_preserves_exact_local_handoff_and_theme_hash(self):
        expected=self.scope['local_acceptance']()
        value=self.https_scope()['public_acceptance'](expected)
        self.assertEqual(value['http'],expected)
        self.assertEqual(value['redirect_status'],308)

    def test_16_https_theme_drift_and_weaker_policy_rejected(self):
        expected=self.scope['local_acceptance']();old=self.responses['/theme-init.js']
        self.responses['/theme-init.js']=(200,{'content-type':'application/javascript'},THEME+b' ')
        with self.assertRaisesRegex(Rejected,'HTTPS_QUALIFIED_THEME_CHANGED'):self.https_scope()['public_acceptance'](expected)
        self.responses['/theme-init.js']=old
        status,headers,body=self.responses['/'];headers=copy.copy(headers);headers['content-security-policy']+='; style-src-elem https:'
        self.responses['/']=(status,headers,body)
        with self.assertRaisesRegex(Rejected,'QUALIFIED_ASSET_CSP_CHANGED'):self.https_scope()['public_acceptance'](expected)


if __name__=='__main__':unittest.main()
