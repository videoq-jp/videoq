import importlib.util
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('stage-audio-candidate.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CandidateOverlayTest(unittest.TestCase):
    def test_workflow_host_pin_does_not_change_native_wheel_target(self):
        workflow = (MODULE.ROOT / '.github/workflows/patched-audio-candidate.yml').read_text()
        self.assertIn('python-version-file: .python-version', workflow)
        self.assertNotIn("python-version: '3.12'", workflow)
        self.assertIn('shell: bash', workflow)
        self.assertIn('audio-native/native-smoke.json', workflow)
        self.stage()
        self.assertTrue((self.output / 'av/__init__.py').is_file())

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.candidate = self.root / 'candidate'
        (self.candidate / 'wheels').mkdir(parents=True)
        for name in ['provenance.json', 'source-lock.json', 'build-smoke.json', 'verify.py', 'ffmpeg-config.log']:
            (self.candidate / name).write_text('{}')
        (self.candidate / 'fixtures').mkdir()
        (self.candidate / 'fixtures/sample.wav').write_bytes(b'fixture')
        self.lock = MODULE.ROOT / 'charts/videoq-inference/files/vllm-audio-wheels.json'
        self.manifest = json.loads(self.lock.read_text())
        self.wheel = self.candidate / 'wheels/av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl'
        self.write_wheel(self.wheel, 'av', '19.0.2')
        self.output = self.root / 'overlay'
        self.receipt = self.root / 'identity.json'

    @staticmethod
    def write_wheel(path, name, version, extra=None, tags=None):
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr(f'{name}-{version}.dist-info/METADATA', f'Name: {name}\nVersion: {version}\n')
            archive.writestr(f'{name}-{version}.dist-info/WHEEL', ''.join(
                f'Tag: {tag}\n' for tag in (tags or ['cp312-abi3-manylinux_2_28_x86_64'])))
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

    def test_root_only_export_modes_become_readable_without_changing_bytes(self):
        self.candidate.chmod(0o700)
        (self.candidate / 'verify.py').chmod(0o600)
        data = self.stage()
        self.assertEqual(self.candidate.stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.candidate / 'verify.py').stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o755)
        self.assertEqual(data['candidateFiles'], MODULE.files(self.candidate))

    def test_failed_pipelines_cannot_masquerade_as_success(self):
        for code in ['raise SystemExit(23)', 'raise PermissionError("candidate verifier unreadable")']:
            with self.subTest(code=code):
                script = 'set -euo pipefail\n"$1" -c "$2" 2>&1 | tee "$3"'
                result = subprocess.run(['bash', '-c', script, 'test', sys.executable, code,
                                         str(self.root / 'native.log')], capture_output=True)
                self.assertNotEqual(result.returncode, 0)
        workflow = (MODULE.ROOT / '.github/workflows/patched-audio-candidate.yml').read_text()
        self.assertEqual(workflow.count('set -euo pipefail'), 2)
        self.assertIn('--native-receipt "$RUNNER_TEMP/audio-native/native-smoke.json"', workflow)

    def test_missing_or_forged_native_receipt_rejected(self):
        self.write_wheel(self.wheel, 'av', '19.0.2', {'av.libs/libavcodec-test.so.63': 'ELF fixture'})
        self.stage()
        members = MODULE.files(self.output)
        members = {name: value for name, value in members.items() if name.startswith(('av/', 'av.libs/'))}
        provenance = {'wheel': {'sha256': MODULE.digest(self.wheel), 'members': members},
                      'recipeHashes': {'verify.py': MODULE.digest(self.candidate / 'verify.py')}}
        (self.candidate / 'provenance.json').write_text(json.dumps(provenance))
        # Recreate the identity ledger after constructing this synthetic provenance.
        identity = json.loads(self.receipt.read_text())
        identity['candidateFiles'] = MODULE.files(self.candidate)
        self.receipt.write_text(json.dumps(identity))
        path = self.root / 'native-smoke.json'
        with self.assertRaises(FileNotFoundError):
            MODULE.verify_native(self.candidate, self.output, self.receipt, path)
        report = {'status': 'passed', 'ffmpegVersion': '9.1', 'pyavVersion': '19.0.2',
                  'installedMemberCount': len(members),
                  'compiledFilters': ['abuffer', 'abuffersink', 'aformat', 'aresample', 'buffer', 'buffersink'],
                  'compiledDecoders': ['flac', 'mp3', 'mp3float', 'pcm_s16le'],
                  'compiledEncoders': [], 'nativeMuxers': [],
                  'nativeProtocols': {'0': ['file', 'pipe'], '1': ['file', 'pipe']},
                  'loadedCandidateElfs': ['/opt/videoq-audio/av.libs/libavcodec-test.so.63']}
        names = ['pcm16-16k-mono', 'pcm16-48k-stereo', 'extra_overread.mp3', 'luckynight.flac']
        report['decodeResample'] = [{'fixture': name, 'samples16kMono': 1600} for name in names]
        report['whisperPreprocessing'] = [{'fixture': name, 'samples': 1600, 'duration': 0.1} for name in names]
        path.write_text(json.dumps(report))
        MODULE.verify_native(self.candidate, self.output, self.receipt, path)
        for key, value in [('status', 'failed'), ('ffmpegVersion', '9.0.2'),
                           ('installedMemberCount', 0), ('compiledEncoders', ['wav']),
                           ('whisperPreprocessing', []), ('loadedCandidateElfs', ['/foreign/libavcodec.so'])]:
            with self.subTest(key=key):
                forged = dict(report, **{key: value})
                path.write_text(json.dumps(forged))
                with self.assertRaises(ValueError):
                    MODULE.verify_native(self.candidate, self.output, self.receipt, path)

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

    def test_compatible_platform_aliases_require_matching_internal_tags(self):
        self.wheel = self.wheel.rename(self.wheel.with_name(
            'av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.manylinux_2_17_x86_64.whl'))
        self.write_wheel(self.wheel, 'av', '19.0.2', tags=[
            'cp312-abi3-manylinux_2_28_x86_64', 'cp312-abi3-manylinux_2_17_x86_64'])
        self.stage()
        MODULE.verify(self.candidate, self.output, self.receipt)
        self.write_wheel(self.wheel, 'av', '19.0.2', tags=['cp313-abi3-manylinux_2_28_x86_64'])
        with self.assertRaisesRegex(ValueError, 'metadata tags'):
            MODULE.candidate_wheel(self.candidate)
        self.wheel.rename(self.wheel.with_name(
            'av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.musllinux_1_2_x86_64.whl'))
        with self.assertRaisesRegex(ValueError, 'platform alias'):
            MODULE.candidate_wheel(self.candidate)


if __name__ == '__main__':
    unittest.main()
