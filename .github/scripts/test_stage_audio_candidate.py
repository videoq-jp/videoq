import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('stage-audio-candidate.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CandidateOverlayTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.candidate = self.root / 'candidate'
        (self.candidate / 'wheels').mkdir(parents=True)
        for name in ['provenance.json', 'build-smoke.json', 'verify.py', 'ffmpeg-config.log']:
            (self.candidate / name).write_text('{}')
        self.lock = MODULE.ROOT / 'charts/videoq-inference/files/vllm-audio-wheels.json'
        self.manifest = json.loads(self.lock.read_text())
        self.wheel = self.candidate / 'wheels/av-19.0.2-cp312-cp312-manylinux_2_28_x86_64.whl'
        self.write_wheel(self.wheel, 'av', '19.0.2')
        self.output = self.root / 'overlay'
        self.receipt = self.root / 'identity.json'

    @staticmethod
    def write_wheel(path, name, version, extra=None):
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr(f'{name}-{version}.dist-info/METADATA', f'Name: {name}\nVersion: {version}\n')
            archive.writestr(f'{name}/__init__.py', '# fixture')
            for key, value in (extra or {}).items():
                archive.writestr(key, value)

    def cached(self, package, _cache, _download):
        self.assertNotEqual(package['name'], 'av', 'Old PyAV must never be downloaded or extracted')
        path = self.root / (package['name'] + '.whl')
        self.write_wheel(path, package['name'], package['version'])
        return path

    def stage(self):
        with patch.object(MODULE.LOCKED, 'cached_wheel', side_effect=self.cached):
            return MODULE.stage(self.candidate, self.lock, self.root / 'cache', self.output, self.receipt)

    def test_exact_overlay_preserves_companions_guard_and_artifact_identity(self):
        data = self.stage()
        self.assertEqual(data['wheelSha256'], MODULE.digest(self.wheel))
        self.assertEqual((self.output / 'sitecustomize.py').read_bytes(),
                         (MODULE.ROOT / 'apps/inference/whisper/audio_guard.py').read_bytes())
        for package in self.manifest['packages']:
            self.assertTrue((self.output / package['name'] / '__init__.py').is_file())
        MODULE.verify(self.candidate, self.output, self.receipt)
        (self.output / 'av/__init__.py').write_text('# changed')
        with self.assertRaisesRegex(ValueError, 'bytes changed'):
            MODULE.verify(self.candidate, self.output, self.receipt)

    def test_unexpected_platform_member_and_startup_hook_fail_closed(self):
        for member in ['../escape', 'unreviewed/__init__.py', 'av/../../escape', 'av/boot.pth']:
            with self.subTest(member=member):
                self.write_wheel(self.wheel, 'av', '19.0.2', {member: 'bad'})
                with self.assertRaises(ValueError):
                    self.stage()
                self.assertFalse(self.output.exists())
        self.wheel.rename(self.wheel.with_name('av-19.0.2-cp313-cp313-linux_x86_64.whl'))
        with self.assertRaisesRegex(ValueError, 'native CPython'):
            self.stage()

    def test_changed_provenance_symlink_and_nonfresh_destination_rejected(self):
        self.stage()
        (self.candidate / 'provenance.json').write_text('{"changed":true}')
        with self.assertRaisesRegex(ValueError, 'bytes changed'):
            MODULE.verify(self.candidate, self.output, self.receipt)
        with self.assertRaisesRegex(ValueError, 'fresh'):
            self.stage()
        (self.candidate / 'external').symlink_to(self.lock)
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            MODULE.files(self.candidate)


if __name__ == '__main__':
    unittest.main()
