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

    def test_python_discovery_is_independent_of_container_publication(self):
        with patch.object(runtime, "request", return_value=self.python_releases("3.14.11", "3.14.10")) as request:
            result = runtime.discover(runtime.ROOT, self.python_data, "python", False)
        self.assertEqual(result["python"], "3.14.11")
        self.assertEqual(request.call_count, 1)
        self.assertEqual(self.python_data["python"], "3.14.9")

    def test_unknown_next_line_does_not_duplicate_current_line_digest_updates(self):
        with patch.object(runtime, "request", return_value=[{"version": "v26.12.1", "lts": False}]) as request:
            self.assertEqual(runtime.discover(runtime.ROOT, self.data, "node", True), self.data)
            self.assertEqual(request.call_count, 1)

    def test_versions_and_archive_sources_cannot_inject_commands(self):
        for value in ["26", "26.12.1;echo bad", "26.12.1-rc.1", "$(touch file)"]:
            with self.assertRaises(ValueError):
                runtime.version(value)
    def test_tool_release_channels_separate_major_lines_and_exclude_prereleases(self):
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

    def test_runtime_render_preserves_dependabot_image_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_text((runtime.ROOT / "package.json").read_text())
            for path in [*runtime.NODE_FILES, "apps/worker/Dockerfile", "apps/worker/Dockerfile.local", "apps/worker/Dockerfile.onprem"]:
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                # A different image version/digest must survive rendering and unrelated tool updates.
                text = (runtime.ROOT / path).read_text()
                text = __import__('re').sub(r"(?m)^(FROM \S+@sha256:)[a-f0-9]{64}", r"\g<1>" + "9" * 64, text)
                target.write_text(text)
            files = runtime.rendered(root, self.data)
            for path, text in files.items():
                if "Dockerfile" in path:
                    original = (root / path).read_text()
                    self.assertEqual([line for line in text.splitlines() if line.startswith("FROM ")],
                                     [line for line in original.splitlines() if line.startswith("FROM ")])

    def test_all_runtime_discovery_leaves_images_to_dependabot(self):
        self.assertNotIn("images", self.data)
        with patch.object(runtime, "request", return_value=[]):
            self.assertEqual(runtime.discover(runtime.ROOT, self.data, "node", False), self.data)
            self.assertEqual(runtime.discover(runtime.ROOT, self.data, "python", False), self.data)
        config = (runtime.ROOT / ".github/dependabot.yml").read_text()
        main_docker = config.split("  - package-ecosystem: docker\n", 1)[1].split("  # This service", 1)[0]
        for image in ["node", "ghcr.io/astral-sh/uv", "astral-sh/uv"]:
            self.assertNotIn("dependency-name: " + image, main_docker)
        for image in ["python", "public.ecr.aws/lambda/python", "lambda/python"]:
            self.assertIn('dependency-name: ' + image + '\n        update-types: ["version-update:semver-major", "version-update:semver-minor"]', main_docker)
        self.assertNotIn('version-update:semver-patch', main_docker)


if __name__ == "__main__":
    unittest.main()


class DependabotToolTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((runtime.ROOT / runtime.MANIFEST).read_text())

    def test_declared_tools_require_unique_exact_pins(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / '.github/runtime-tools'
            folder.mkdir(parents=True)
            (folder / 'package.json').write_text(json.dumps({'dependencies': {'npm': '12.2.3'}}))
            requirements = folder / 'requirements.txt'
            requirements.write_text('pip==26.2.2\nuv==0.13.9\n')
            self.assertEqual(runtime.declared_tools(root), {'npm': '12.2.3', 'pip': '26.2.2', 'uv': '0.13.9'})
            for text in ['pip>=26\nuv==0.13.9\n', 'pip==26.2.2\npip==26.2.3\nuv==0.13.9\n', 'pip==26.2.2\n']:
                requirements.write_text(text)
                with self.assertRaises(ValueError):
                    runtime.declared_tools(root)

    def test_tools_use_only_the_dependabot_pin_and_preserve_channels(self):
        for name, previous, current, future in [('npm', '12.2.0', '12.2.1', '13.0.0'),
                                                ('pip', '26.2.0', '26.2.1', '27.0.0'),
                                                ('uv', '0.13.1', '0.13.2', '0.14.0')]:
            data = copy.deepcopy(self.data)
            original = data[name]
            data[name] = previous
            data['tool_downloads'][name] = json.loads(json.dumps(data['tool_downloads'][name]).replace(original, previous))
            tools = {name: current}
            def resolved(result, runtime_name, candidate, request):
                self.assertEqual(runtime_name, name)
                self.assertEqual(candidate, current)
                result['tool_downloads'][name] = json.loads(json.dumps(result['tool_downloads'][name]).replace(previous, candidate))
                result[name] = candidate
                return result
            with patch.object(runtime, 'declared_tools', return_value=tools), \
                    patch.object(runtime.managers, 'resolve', side_effect=resolved) as resolve, \
                    patch.object(runtime, 'request') as request:
                self.assertEqual(runtime.discover(runtime.ROOT, data, name, False)[name], current)
                resolve.assert_called_once()
                request.assert_not_called()
            for requested, upgrade in [(future, False), (current, True), (previous, False), ('0.0.1', False)]:
                with patch.object(runtime, 'declared_tools', return_value={name: requested}), \
                        patch.object(runtime.managers, 'resolve') as resolve:
                    self.assertEqual(runtime.discover(runtime.ROOT, data, name, upgrade), data)
                    resolve.assert_not_called()

    def test_exact_npm_metadata_is_bound_to_requested_release(self):
        data = copy.deepcopy(self.data)
        target = data['npm']
        metadata = {'version': target, 'dist': {'tarball': data['tool_downloads']['npm']['url'],
                                              'integrity': data['tool_downloads']['npm']['integrity']}}
        request = unittest.mock.Mock(return_value=metadata)
        self.assertEqual(runtime.managers.resolve(data, 'npm', target, request), self.data)
        request.assert_called_once_with(f'https://registry.npmjs.org/npm/{target}')
        metadata['version'] = '0.0.1'
        with self.assertRaisesRegex(ValueError, 'Mismatched'):
            runtime.managers.resolve(data, 'npm', target, request)

    def test_wrong_or_unstable_pip_and_uv_releases_are_rejected(self):
        for name, metadata in [('pip', {'info': {'version': '0.0.1'}}),
                               ('uv', {'tag_name': self.data['uv'], 'prerelease': True}),
                               ('uv', {'tag_name': '0.0.1'})]:
            with self.assertRaisesRegex(ValueError, 'Mismatched'):
                runtime.managers.resolve(copy.deepcopy(self.data), name, self.data[name], lambda _: metadata)

    def test_exact_pip_wheel_and_all_uv_archives_are_resolved_without_release_search(self):
        for name in ['pip', 'uv']:
            data = copy.deepcopy(self.data)
            target = data[name]
            if name == 'pip':
                pin = data['tool_downloads']['pip']
                metadata = {'info': {'version': target}, 'urls': [{
                    'filename': f'pip-{target}-py3-none-any.whl', 'url': pin['url'],
                    'digests': {'sha256': pin['sha256']}, 'yanked': False}]}
                url = f'https://pypi.org/pypi/pip/{target}/json'
            else:
                metadata = {'tag_name': target, 'draft': False, 'prerelease': False,
                            'assets': [{'name': f'uv-{triple}.tar.gz',
                                        'browser_download_url': data['tool_downloads']['uv'][platform]['url'],
                                        'digest': 'sha256:' + data['tool_downloads']['uv'][platform]['sha256']}
                                       for platform, triple in runtime.managers.TARGETS.items()]}
                url = f'https://api.github.com/repos/astral-sh/uv/releases/tags/{target}'
            request = unittest.mock.Mock(return_value=metadata)
            self.assertEqual(runtime.managers.resolve(data, name, target, request), self.data)
            request.assert_called_once_with(url)

    def test_pip_two_component_releases_keep_the_official_version_spelling(self):
        self.assertTrue(runtime.managers.stable('26.3', 'pip'))
        self.assertFalse(runtime.managers.stable('26.3', 'npm'))
        self.assertFalse(runtime.managers.stable('0.13', 'uv'))
        self.assertEqual(runtime.managers.newer('26.2.2', 'pip', False, ['26.3']), '26.3')
        self.assertEqual(runtime.managers.newer('26.3', 'pip', False, ['26.3.0']), '26.3')
        self.assertEqual(runtime.managers.newer('26.3', 'pip', True, ['27.0']), '27.0')
        metadata = {'info': {'version': '26.3'}, 'urls': [{
            'filename': 'pip-26.3-py3-none-any.whl',
            'url': 'https://files.pythonhosted.org/packages/test/pip-26.3-py3-none-any.whl',
            'digests': {'sha256': 'a' * 64}}]}
        data = runtime.managers.resolve(copy.deepcopy(self.data), 'pip', '26.3', lambda _: metadata)
        self.assertEqual(data['pip'], '26.3')
        runtime.validate(data)
