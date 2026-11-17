import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("runtime_versions", Path(__file__).with_name("runtime-versions.py"))
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((runtime.ROOT / runtime.MANIFEST).read_text())
        # Release-discovery scenarios have fixed candidate versions. Keep their
        # starting point independent of whichever runtime production now pins.
        self.python_data = copy.deepcopy(self.data)
        self.python_data["python"] = "3.14.9"
        self.python_data["python_minimum"] = "3.12"
        for key, repo, tag in [
            ("python_local", "python", "3.14.9-slim-bookworm"),
            ("python_onprem", "python", "3.14.9-slim-bookworm"),
            ("python_lambda", "public.ecr.aws/lambda/python", "3.14"),
        ]:
            self.python_data["images"][key] = repo + ":" + tag + "@sha256:" + "0" * 64

    def test_node_security_patches_do_not_wait_for_a_new_lts_line(self):
        releases = [{"version": "v26.12.1", "security": True, "lts": False},
                    {"version": "v27.0.0", "lts": False}, {"version": "v28.1.0", "lts": "Next"},
                    {"version": "v29.0.0-rc.1", "lts": False}]
        self.assertEqual(runtime.latest("26.10.0", "node", False, releases), "26.12.1")
        self.assertEqual(runtime.latest("26.10.0", "node", True, releases), "28.1.0")

    def test_python_release_lines_are_separate_and_prereleases_excluded(self):
        releases = [{"name": "Python " + v, "is_published": True, "pre_release": pre}
                    for v, pre in [("3.14.9", False), ("3.15.1", False), ("3.16.0a1", True)]]
        self.assertEqual(runtime.latest("3.14.8", "python", False, releases), "3.14.9")
        self.assertEqual(runtime.latest("3.14.8", "python", True, releases), "3.15.1")

    def python_releases(self, *versions):
        return [{"name": "Python " + v, "is_published": True, "pre_release": False} for v in versions]

    def pinned_image(self, repo, tag):
        return repo + ":" + tag + "@sha256:" + "1" * 64

    def test_python_selects_latest_complete_image_set_not_latest_interpreter(self):
        previous = copy.deepcopy(self.python_data)
        def digest(repo, tag):
            if tag == "3.14.11-slim-bookworm":
                raise runtime.MissingImage("Not yet published")
            return self.pinned_image(repo, tag)
        with patch.object(runtime, "request", return_value=self.python_releases("3.14.11", "3.14.10")), patch.object(runtime, "image_digest", side_effect=digest):
            result = runtime.discover(runtime.ROOT, self.python_data, "python", False)
        self.assertEqual(result["python"], "3.14.10")
        self.assertIn("3.14.10-slim-bookworm@sha256:", result["images"]["python_onprem"])
        self.assertEqual(self.python_data, previous)

    def test_python_pending_current_patch_still_refreshes_current_digests(self):
        def digest(repo, tag):
            if tag.startswith("3.14.10-"):
                raise runtime.MissingImage("Not yet published")
            return self.pinned_image(repo, tag)
        with patch.object(runtime, "request", return_value=self.python_releases("3.14.10")), patch.object(runtime, "image_digest", side_effect=digest):
            result = runtime.discover(runtime.ROOT, self.python_data, "python", False)
        self.assertEqual(result["python"], self.python_data["python"])
        self.assertNotEqual(result["images"]["python_local"], self.python_data["images"]["python_local"])

    def test_python_next_requires_lambda_support_and_never_partially_changes_pins(self):
        def digest(repo, tag):
            if repo == "public.ecr.aws/lambda/python":
                raise runtime.MissingImage("Lambda series not yet published")
            return self.pinned_image(repo, tag)
        with patch.object(runtime, "request", return_value=self.python_releases("3.15.2", "3.15.1")), patch.object(runtime, "image_digest", side_effect=digest):
            self.assertEqual(runtime.discover(runtime.ROOT, self.python_data, "python", True), self.python_data)

    def test_python_next_can_select_a_complete_supported_release(self):
        with patch.object(runtime, "request", return_value=self.python_releases("3.15.1")), patch.object(runtime, "image_digest", side_effect=self.pinned_image):
            result = runtime.discover(runtime.ROOT, self.python_data, "python", True)
        self.assertEqual(result["python"], "3.15.1")
        self.assertIn(":3.15@sha256:", result["images"]["python_lambda"])

    def test_no_next_python_release_does_not_refresh_current_images(self):
        with patch.object(runtime, "request", return_value=self.python_releases("3.14.10")), patch.object(runtime, "image_digest") as digest:
            self.assertEqual(runtime.discover(runtime.ROOT, self.python_data, "python", True), self.python_data)
            digest.assert_not_called()

    def test_missing_pinned_image_and_invalid_architectures_remain_failures(self):
        for releases, error in [([], runtime.MissingImage("Pinned image gone")),
                                (self.python_releases("3.15.1"), ValueError("Missing arm64"))]:
            with self.subTest(error=error), patch.object(runtime, "request", return_value=releases), patch.object(runtime, "image_digest", side_effect=error):
                with self.assertRaises(type(error)):
                    runtime.discover(runtime.ROOT, self.python_data, "python", bool(releases))

    def test_only_registry_manifest_unknown_is_a_legitimate_missing_image(self):
        url = "https://registry-1.docker.io/v2/library/python/manifests/3.14.10-slim-bookworm"
        for status, body, expected in [
            (404, b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', runtime.MissingImage),
            (404, b'{"errors":[{"code":"NAME_UNKNOWN"}]}', urllib.error.HTTPError),
            (404, b'not JSON', urllib.error.HTTPError),
            (404, b'{"errors":[null]}', urllib.error.HTTPError),
            (401, b'{"errors":[{"code":"UNAUTHORIZED"}]}', urllib.error.HTTPError),
            (429, b'{}', urllib.error.HTTPError), (500, b'{}', urllib.error.HTTPError),
        ]:
            with self.subTest(status=status, body=body):
                error = urllib.error.HTTPError(url, status, "registry failure", {}, io.BytesIO(body))
                with patch.object(runtime, "request", side_effect=[{"token": "test"}, error]):
                    with self.assertRaises(expected):
                        runtime.image_digest("python", "3.14.10-slim-bookworm")
                error.close()

    def test_registry_authentication_404_is_not_publication_lag(self):
        error = urllib.error.HTTPError("https://auth.docker.io/token", 404, "missing", {}, io.BytesIO(b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}'))
        with patch.object(runtime, "request", side_effect=error), self.assertRaises(urllib.error.HTTPError):
            runtime.image_digest("python", "3.14.10-slim-bookworm")
        error.close()

    def test_available_multiarch_image_is_pinned_to_exact_manifest_bytes(self):
        body = b'{"manifests":[{"platform":{"architecture":"amd64"}},{"platform":{"architecture":"arm64"}}]}'
        with patch.object(runtime, "request", side_effect=[{"token": "test"}, body]):
            self.assertEqual(runtime.image_digest("python", "3.14.10-alpine"),
                             "python:3.14.10-alpine@sha256:" + hashlib.sha256(body).hexdigest())

    def test_discovery_does_not_hide_network_or_registry_failures(self):
        for error in [urllib.error.HTTPError("https://registry.invalid", 429, "limit", {}, None),
                      urllib.error.URLError("offline")]:
            with self.subTest(error=error), patch.object(runtime, "request", return_value=self.python_releases("3.15.1")), patch.object(runtime, "image_digest", side_effect=error):
                with self.assertRaises(type(error)):
                    runtime.discover(runtime.ROOT, self.python_data, "python", True)
            if isinstance(error, urllib.error.HTTPError):
                error.close()

    def test_unknown_next_line_does_not_duplicate_current_line_digest_updates(self):
        with patch.object(runtime, "request", return_value=[{"version": "v26.12.1", "lts": False}]) as request:
            self.assertEqual(runtime.discover(runtime.ROOT, self.data, "node", True), self.data)
            self.assertEqual(request.call_count, 1)

    def test_versions_and_archive_sources_cannot_inject_commands(self):
        for value in ["26", "26.12.1;echo bad", "26.12.1-rc.1", "$(touch file)"]:
            with self.assertRaises(ValueError):
                runtime.version(value)
    def test_unknown_image_repositories_are_rejected_before_network_access(self):
        with patch.object(runtime, "request") as request:
            for name in ["evil.example/ghcr.io/astral-sh/uv", "ghcr.io/evil", "node/../../other"]:
                with self.assertRaises(ValueError):
                    runtime.image_digest(name, "26.12.1")
            request.assert_not_called()

    def test_image_manifest_must_cover_both_production_architectures(self):
        def response(url, headers=None, raw=False):
            return b'{"manifests":[{"platform":{"architecture":"amd64"}}]}' if raw else {"token": "not-a-secret"}
        with patch.object(runtime, "request", side_effect=response), self.assertRaises(ValueError):
            runtime.image_digest("node", "26.12.1-bookworm-slim")

    def test_tool_major_updates_cannot_block_current_line_security_fixes(self):
        versions = ["12.2.1", "13.0.0", "14.0.0-rc.1"]
        self.assertEqual(runtime.managers.newer("12.2.0", "npm", False, versions), "12.2.1")
        self.assertEqual(runtime.managers.newer("12.2.0", "npm", True, versions), "13.0.0")
        self.assertEqual(runtime.managers.newer("0.13.4", "uv", False, ["0.13.5", "0.14.0"]), "0.13.5")
        self.assertEqual(runtime.managers.newer("0.13.4", "uv", True, ["0.13.5", "0.14.0"]), "0.14.0")

    def test_changed_distribution_bytes_are_rejected_before_extraction_or_execution(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, *_): return b"tampered archive"
        with patch.object(runtime.managers.urllib.request, "urlopen", return_value=Response()), self.assertRaisesRegex(ValueError, "hash mismatch"):
            runtime.managers.verified({"url": "https://example.invalid", "sha256": "0" * 64})

    def test_tool_pins_require_exact_official_distribution_urls(self):
        for name in ["npm", "pip"]:
            bad = copy.deepcopy(self.data)
            bad["tool_downloads"][name]["url"] = "https://example.invalid/payload"
            with self.assertRaises(ValueError):
                runtime.validate(bad)

    def test_render_is_idempotent_and_keeps_package_dependencies(self):
        files = runtime.rendered(runtime.ROOT, self.data)
        before = json.loads((runtime.ROOT / "package.json").read_text())
        after = json.loads(files["package.json"])
        for field in ["dependencies", "devDependencies", "overrides", "peerDependencies"]:
            self.assertEqual(before.get(field), after.get(field))
        for name, content in files.items():
            self.assertEqual((runtime.ROOT / name).read_text(), content, name)
        self.assertEqual(files[".node-version"].strip(), self.data["node"])
        self.assertEqual(files[".python-version"].strip(), self.data["python"])

    def test_onprem_images_follow_canonical_runtime_and_package_managers(self):
        files = runtime.rendered(runtime.ROOT, self.data)
        for path, image, manager in [
            ("apps/api/Dockerfile", "node_onprem", "npm"),
            ("apps/worker/Dockerfile.onprem", "python_onprem", "pip"),
        ]:
            self.assertIn("FROM " + self.data["images"][image], files[path])
            self.assertIn("# BEGIN managed " + manager, files[path])
        self.assertIn("FROM " + self.data["images"]["uv"], files["apps/worker/Dockerfile.onprem"])

    def test_node_discovery_refreshes_the_onprem_image_too(self):
        with patch.object(runtime, "request", return_value=[]), patch.object(runtime, "image_digest", side_effect=lambda repo, tag: repo + ":" + tag + "@sha256:" + "1" * 64) as digest:
            changed = runtime.discover(runtime.ROOT, self.data, "node", False)
        self.assertNotEqual(changed["images"]["node_onprem"], self.data["images"]["node_onprem"])
        self.assertEqual(digest.call_count, 3)

    def test_python_discovery_refreshes_the_onprem_image_too(self):
        with patch.object(runtime, "request", return_value=[]), patch.object(runtime, "image_digest", side_effect=lambda repo, tag: repo + ":" + tag + "@sha256:" + "1" * 64) as digest:
            changed = runtime.discover(runtime.ROOT, self.data, "python", False)
        self.assertNotEqual(changed["images"]["python_onprem"], self.data["images"]["python_onprem"])
        self.assertEqual(digest.call_count, 3)


if __name__ == "__main__":
    unittest.main()
