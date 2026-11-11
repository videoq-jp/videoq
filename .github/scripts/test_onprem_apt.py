import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SECURITY = ROOT / 'apps/inference/whisper/security'
spec = importlib.util.spec_from_file_location('verify_apt', SECURITY / 'verify_apt.py')
apt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apt)


class NvidiaAptFixTests(unittest.TestCase):
    def test_installed_fixed_packages_are_required(self):
        packages = [{'name': name, 'version': '2.8.4ubuntu0.1', 'architecture': 'amd64', 'status': 'installed'}
                    for name in sorted(apt.PACKAGES)]
        release = {'ID': 'ubuntu', 'VERSION_ID': '24.04'}
        self.assertEqual(apt.verify(packages, release), packages)
        for value in ('2.8.3', '2.8.4', '2.8.4ubuntu0.0'):
            altered = copy.deepcopy(packages)
            altered[0]['version'] = value
            with self.subTest(version=value), self.assertRaises(ValueError):
                apt.verify(altered, release)
        for key, value in [('architecture', 'arm64'), ('status', 'not-installed')]:
            altered = copy.deepcopy(packages)
            altered[0][key] = value
            with self.assertRaises(ValueError):
                apt.verify(altered, release)
        with self.assertRaises(ValueError):
            apt.verify(packages[:1], release)
        with self.assertRaises(ValueError):
            apt.verify(packages, {'ID': 'ubuntu', 'VERSION_ID': '22.04'})

    def test_fixed_vex_covers_only_the_vendor_fixed_package_purls(self):
        document = json.loads((SECURITY / 'apt-fixed.openvex.json').read_text())
        self.assertEqual(len(document['statements']), 1)
        statement = document['statements'][0]
        self.assertEqual(statement['status'], 'fixed')
        self.assertEqual(statement['vulnerability']['name'], 'CVE-2026-109518')
        self.assertEqual({p['@id'] for p in statement['products']}, {
            f'pkg:deb/ubuntu/{name}@2.8.4ubuntu0.1?arch=amd64&distro=ubuntu-24.04' for name in apt.PACKAGES})
        dockerfile = (ROOT / 'apps/inference/whisper/Dockerfile.vllm').read_text()
        refresh = (ROOT / 'apps/inference/whisper/Dockerfile.vllm-base').read_text()
        self.assertNotIn('apt-get', dockerfile)
        self.assertIn('FROM ghcr.io/videoq-jp/videoq-vllm@sha256:', dockerfile)
        for operation in ('update', 'upgrade'):
            self.assertIn('apt-get -o Acquire::Retries=3', refresh)
            self.assertIn(' ' + operation, refresh)
        self.assertIn('-o APT::Update::Error-Mode=any update', refresh)
        self.assertIn('-o Acquire::http::Timeout=30', refresh)
        self.assertIn('-o Acquire::https::Timeout=30', refresh)
        self.assertIn('python3 /usr/share/videoq/security/verify_apt.py', dockerfile)


if __name__ == '__main__':
    unittest.main()
