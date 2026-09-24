import contextlib
import importlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import install  # noqa: E402
import preflight  # noqa: E402


REGISTRY = {"harnesses": {"codex": {"binary": "codex", "persona": "Codex CLI", "install": ["codex"]}}}


class PreflightPersonaTests(unittest.TestCase):
    def run_preflight(self, *extra, expected=0):
        argv = ["preflight.py", "--skip-mcp", *extra]
        preflight.results.clear()
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.object(preflight.shutil, "which", side_effect=lambda binary: f"/usr/bin/{binary}"), \
             mock.patch("zolib.harnesses", return_value=REGISTRY), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(preflight.main(), expected)
        return preflight.results.copy()

    def test_validates_expected_installed_harness_personas(self):
        with mock.patch("zolib.list_rows", return_value=["id='p1', name='Codex CLI'"]):
            results = self.run_preflight()
        check = next(row for row in results if row[0] == "harness personas")
        self.assertTrue(check[1])

    def test_reports_missing_harness_persona(self):
        with mock.patch("zolib.list_rows", return_value=[]):
            results = self.run_preflight(expected=1)
        check = next(row for row in results if row[0] == "harness personas")
        self.assertFalse(check[1])
        self.assertIn("Codex CLI", check[3])

    def test_skips_persona_probe_when_requested(self):
        with mock.patch("zolib.list_rows") as list_rows:
            results = self.run_preflight("--skip-personas")
        list_rows.assert_not_called()
        check = next(row for row in results if row[0] == "harness personas")
        self.assertFalse(check[2])


class InstallPersonaTests(unittest.TestCase):
    def test_full_apply_registers_personas(self):
        with tempfile.TemporaryDirectory() as target, \
             mock.patch.object(sys, "argv", ["install.py", "--apply", "--target", target]), \
             mock.patch.object(install.shutil, "which", side_effect=lambda binary: f"/usr/bin/{binary}"), \
             mock.patch.object(install.subprocess, "run") as run, \
             contextlib.redirect_stdout(io.StringIO()):
            run.return_value.returncode = 0
            self.assertEqual(install.main(), 0)
        command = run.call_args.args[0]
        self.assertEqual(command[-1], "--apply")
        self.assertTrue(command[-2].endswith("register-personas.py"))

    def test_skip_personas_preserves_opt_out(self):
        with tempfile.TemporaryDirectory() as target, \
             mock.patch.object(sys, "argv", ["install.py", "--apply", "--only", "bridge", "--skip-personas", "--target", target]), \
             mock.patch.object(install.subprocess, "run") as run, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(install.main(), 0)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
