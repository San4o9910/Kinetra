#!/usr/bin/env python3
"""Offline regression checks for a dormant one-expression Docker query patch.

No Docker, network or host mutation. Real engine verification is separately
recorded in run 34777637820; these checks protect the unchanged acceptance rules.
"""
import ast
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).parent
FROZEN = "654ae707445717a96b04c1a7b1f9e428e22ff06ccb04f40c68a2bf6b2ae11524"
PROPOSED = "e7954b99525f9a66f174d4c4729f0c6287b11f3c8cb2432106e4283d87d6e9e4"
OLD = '{{if .State.Health}}'
NEW = '{{if (index .State "Health")}}'
INSTALLED = (ROOT / "start-application-host.py").read_text()
SOURCE = INSTALLED.replace(NEW, OLD) if NEW in INSTALLED else INSTALLED
FIXED = SOURCE.replace(OLD, NEW)


class GuardError(Exception):
    pass


def require(condition, category):
    if not condition:
        raise GuardError(category)


def functions(source, names, extra):
    nodes = [node for node in ast.parse(source).body
             if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in nodes} == set(names)
    scope = {"require": require, "Error": GuardError, "json": json,
             "CID": re.compile(r"[a-f0-9]{64}"), **extra}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<isolated-frozen-functions>", "exec"), scope)
    return scope


class HealthQueryProposal(unittest.TestCase):
    def test_exact_original_and_proposed_identity(self):
        self.assertEqual(hashlib.sha256(SOURCE.encode()).hexdigest(), FROZEN)
        self.assertEqual(SOURCE.count(OLD), 1)
        self.assertEqual(hashlib.sha256(FIXED.encode()).hexdigest(), PROPOSED)

    def test_patch_applies_to_exact_original(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "ops/timeweb/start-application-host.py"
            target.parent.mkdir(parents=True)
            target.write_text(SOURCE)
            subprocess.run(["git", "apply", str((ROOT / "start-health-query-fix-20260913.patch").resolve())],
                           cwd=folder, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(target.read_text(), FIXED)

    def test_all_executable_checks_unchanged(self):
        before, after = ast.parse(SOURCE), ast.parse(FIXED)
        edited = 0
        for node in ast.walk(after):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and NEW in node.value:
                node.value = node.value.replace(NEW, OLD)
                edited += 1
        self.assertEqual(edited, 1)
        self.assertEqual(ast.dump(before), ast.dump(after))

    def test_inspection_preserves_missing_healthy_and_unhealthy_states(self):
        for health in (None, "starting", "healthy", "unhealthy"):
            value = {"id": "a" * 64, "health": health, "running": health is not None}
            calls = []
            def command(argv, **kwargs):
                calls.append((argv, kwargs))
                return json.dumps(value)
            scope = functions(FIXED, {"inspect_container"}, {"command": command})
            self.assertEqual(scope["inspect_container"]("a" * 64), value)
            argv, kwargs = calls[0]
            self.assertEqual(argv[:5], ["/usr/bin/docker", "inspect", "--type", "container", "--format"])
            self.assertIn(NEW, argv[5])
            self.assertNotIn(".Config.Env", argv[5])
            self.assertEqual(kwargs, {"capture": True})

    def test_invalid_container_id_cannot_invoke_docker(self):
        scope = functions(FIXED, {"inspect_container"},
                          {"command": lambda *a, **k: self.fail("Docker must not be called")})
        with self.assertRaisesRegex(GuardError, "CONTAINER_ID_REQUIRED"):
            scope["inspect_container"]("--all")

    def test_backend_healthy_is_required(self):
        for health in ("unhealthy", "bogus"):
            scope = functions(FIXED, {"wait_for_backend"}, {
                "inspect_container": lambda _id: {"running": True, "status": "running", "health": health},
                "time": SimpleNamespace(monotonic=lambda: 0, sleep=lambda _: self.fail("must reject immediately"))})
            with self.assertRaisesRegex(GuardError, "BACKEND_HEALTH_FAILED"):
                scope["wait_for_backend"]("a" * 64)

    def test_missing_health_cannot_be_accepted_as_healthy(self):
        ticks = iter([0, 1, 151])
        scope = functions(FIXED, {"wait_for_backend"}, {
            "inspect_container": lambda _id: {"running": True, "status": "running", "health": None},
            "time": SimpleNamespace(monotonic=lambda: next(ticks), sleep=lambda _: None)})
        with self.assertRaisesRegex(GuardError, "BACKEND_HEALTH_DEADLINE"):
            scope["wait_for_backend"]("a" * 64)

    def test_running_healthy_backend_can_proceed(self):
        scope = functions(FIXED, {"wait_for_backend"}, {
            "inspect_container": lambda _id: {"running": True, "status": "running", "health": "healthy"},
            "time": SimpleNamespace(monotonic=lambda: 0, sleep=lambda _: self.fail("healthy needs no wait"))})
        self.assertIsNone(scope["wait_for_backend"]("a" * 64))


if __name__ == "__main__":
    unittest.main()
