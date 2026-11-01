import copy
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("supply_chain", Path(__file__).with_name("supply-chain.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class LockPolicyTests(unittest.TestCase):
    def setUp(self):
        self.entry = {"version": "1.0.0", "resolved": "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
                      "integrity": "sha512-" + "A" * 86 + "=="}
        self.lock = {"lockfileVersion": 3, "packages": {"": {}, "node_modules/example": self.entry}}

    def test_registry_package(self):
        self.assertEqual(len(policy.npm_packages(self.lock, [])), 1)

    def test_aliases_are_scanned_under_the_registry_name(self):
        self.lock["packages"]["node_modules/native"] = {
            **self.entry, "name": "typescript",
        }
        packages = policy.npm_packages(self.lock, [])
        self.assertIn(("npm", "typescript", "1.0.0"), packages)
        self.assertNotIn(("npm", "native", "1.0.0"), packages)
        # Renaming an installed package does not introduce a new release.
        del self.lock["packages"]["node_modules/native"]["name"]
        self.lock["packages"]["node_modules/typescript"] = self.lock["packages"].pop("node_modules/native")
        self.assertEqual(policy.check_changes(packages, policy.npm_packages(self.lock, [])), [])

    def test_aliases_cannot_hide_unreviewed_lifecycle_scripts(self):
        self.entry.update(name="unreviewed", hasInstallScript=True)
        with self.assertRaises(ValueError):
            policy.npm_packages(self.lock, ["example"])

    def test_rejects_registry_spoofs_and_unpinned_sources(self):
        for source in ["http://registry.npmjs.org/pkg", "https://registry.npmjs.org.evil.test/pkg",
                       "https://evil@registry.npmjs.org/pkg", "git+https://github.com/evil/pkg", "file:../evil"]:
            with self.subTest(source=source):
                self.entry["resolved"] = source
                with self.assertRaises(ValueError):
                    policy.npm_packages(self.lock, [])

    def test_requires_integrity_and_review_of_new_lifecycle_scripts(self):
        self.entry["hasInstallScript"] = True
        with self.assertRaises(ValueError):
            policy.npm_packages(self.lock, [])
        self.assertTrue(policy.npm_packages(self.lock, ["example"]))
        self.entry.pop("integrity")
        with self.assertRaises(ValueError):
            policy.npm_packages(self.lock, ["example"])

    def test_workspace_links_cannot_escape_checkout(self):
        for target in ["../escape", "/tmp/escape", "node_modules/example", "missing"]:
            self.lock["packages"]["node_modules/link"] = {"link": True, "resolved": target}
            with self.subTest(target=target), self.assertRaises(ValueError):
                policy.npm_packages(self.lock, [])

    def test_same_release_integrity_cannot_change(self):
        before = policy.npm_packages(self.lock, [])
        self.entry["integrity"] = "sha512-" + "B" * 86 + "=="
        with self.assertRaises(ValueError):
            policy.check_changes(before, policy.npm_packages(self.lock, []))

    def test_python_registry_and_hashes(self):
        package = {"name": "example", "version": "1.0.0", "source": {"registry": "https://pypi.org/simple"},
                   "wheels": [{"url": "https://files.pythonhosted.org/example.whl", "hash": "sha256:" + "a" * 64}]}
        lock = {"version": 1, "package": [package]}
        self.assertEqual(len(policy.python_packages(lock)), 1)
        for source in [{"git": "https://github.com/evil/pkg"}, {"editable": "../other"}, {"registry": "https://evil.test"}]:
            altered = copy.deepcopy(lock)
            altered["package"][0]["source"] = source
            with self.assertRaises(ValueError):
                policy.python_packages(altered)
        package["wheels"][0]["hash"] = ""
        with self.assertRaises(ValueError):
            policy.python_packages(lock)

    def test_only_cpu_torch_may_use_the_official_pytorch_wheel_index(self):
        package = {"name": "torch", "version": "2.14.1+cpu",
                   "source": {"registry": "https://download.pytorch.org/whl/cpu"},
                   "wheels": [{"url": "https://download.pytorch.org/whl/cpu/torch-2.14.1.whl",
                               "hash": "sha256:" + "a" * 64}]}
        lock = {"version": 1, "package": [package]}
        self.assertIn(("PyPI", "torch", "2.14.1"), policy.python_packages(lock))
        for name, url in [("other", package["wheels"][0]["url"]),
                          ("torch", "https://download.pytorch.org/whl/unreviewed.whl"),
                          ("torch", "https://evil.test/whl/cpu/torch-2.14.1.whl")]:
            altered = copy.deepcopy(lock)
            altered["package"][0]["name"] = name
            altered["package"][0]["wheels"][0]["url"] = url
            with self.assertRaises(ValueError):
                policy.python_packages(altered)

    def test_known_vulnerabilities_and_incomplete_results_block(self):
        for data in [{"results": [{"vulns": [{"id": "MAL-2026-test"}]}]}, {"results": []},
                     {"results": [{"next_page_token": "more"}]}]:
            with patch.object(policy.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(data).encode())):
                with self.assertRaises(ValueError):
                    policy.scan_osv([("npm", "example", "1.0.0")])

    def test_advisory_service_failure_is_not_success(self):
        with patch.object(policy.urllib.request, "urlopen", side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):
                policy.scan_osv([("npm", "example", "1.0.0")])

    def test_unchanged_versions_are_not_reintroduced(self):
        packages = policy.npm_packages(self.lock, [])
        self.assertEqual(policy.check_changes(packages, packages), [])
        with patch.object(policy.urllib.request, "urlopen") as request:
            policy.scan_osv([])
            request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
