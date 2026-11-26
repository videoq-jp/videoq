"""Offline recipe/verification fail-closed tests; do not build or run native code."""
import ctypes
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


recipe = module('recipe')
verify = module('verify')


class RecipeTests(unittest.TestCase):
    def test_lock_pins_release_builder_every_tool_and_all_eleven_fixes(self):
        data = recipe.lock()
        self.assertEqual(data['ffmpegRelease'], '9.1')
        self.assertRegex(data['builder'], r'@sha256:[a-f0-9]{64}$')
        self.assertEqual(len(data['fixes']), 11)
        self.assertEqual(len({x['cve'] for x in data['fixes']}), 11)
        requirements = (ROOT / 'build-requirements.txt').read_text().splitlines()
        self.assertEqual(requirements, [f"{x['name']}=={x['version']} --hash=sha256:{x['sha256']}"
                                        for x in data['buildTools']])
        for item in data['sources'] + data['buildTools']:
            self.assertRegex(item['sha256'], r'^[a-f0-9]{64}$')
            self.assertTrue(item['url'].startswith('https://'))
            self.assertGreater(item['size'], 0)

    def test_prepare_materializes_a_verified_standalone_context(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'context'
            payload = b'locked input'
            data = {'sources': [{'filename': 'source', 'url': 'https://example.invalid/source',
                                 'size': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}],
                    'buildTools': []}
            with patch.object(recipe, 'lock', return_value=data), \
                    patch.object(recipe.urllib.request, 'urlopen', return_value=io.BytesIO(payload)), \
                    patch.object(recipe, 'verify_inputs', return_value={'fixesVerified': 11}) as checked:
                recipe.prepare(destination)
                checked.assert_called_once_with(destination / 'inputs')
            self.assertEqual((destination / 'inputs/source').read_bytes(), payload)
            self.assertEqual((destination / 'Dockerfile').read_bytes(), (ROOT / 'Dockerfile').read_bytes())
            self.assertTrue((destination / 'recipe/source-verification.json').is_file())
            self.assertTrue((destination / 'recipe/verify.py').is_file())
            with self.assertRaises(FileExistsError):
                recipe.prepare(destination)

    def test_signature_wrong_signer_and_missing_fix_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'ffmpeg-9.1.tar.xz'
            content = b'fixed upstream statement'
            with tarfile.open(archive, 'w:xz') as output:
                info = tarfile.TarInfo('ffmpeg-9.1/lib/fixed.c')
                info.size = len(content)
                output.addfile(info, io.BytesIO(content))
            data = {'sources': [{'filename': archive.name, 'size': archive.stat().st_size,
                                 'sha256': recipe.digest(archive)}], 'buildTools': [],
                    'ffmpegSigningFingerprint': 'A' * 40,
                    'fixes': [{'cve': 'test', 'releaseFiles': [{'path': 'lib/fixed.c',
                               'sha256': hashlib.sha256(content).hexdigest(),
                               'fixAddedLines': ['fixed upstream statement']}]}]}
            good = Mock(stdout='[GNUPG:] VALIDSIG ' + 'A' * 40 + ' rest\n')
            bad = Mock(stdout='[GNUPG:] VALIDSIG ' + 'B' * 40 + ' rest\n')
            with patch.object(recipe, 'lock', return_value=data):
                with patch.object(recipe.subprocess, 'run', side_effect=[Mock(), bad]):
                    with self.assertRaisesRegex(ValueError, 'release signer'):
                        recipe.verify_inputs(root)
                with patch.object(recipe.subprocess, 'run', side_effect=[Mock(), good]):
                    self.assertEqual(recipe.verify_inputs(root)['fixesVerified'], 1)
                data['fixes'][0]['releaseFiles'][0]['fixAddedLines'] = ['absent fix']
                with patch.object(recipe.subprocess, 'run', side_effect=[Mock(), good]):
                    with self.assertRaisesRegex(ValueError, 'Missing upstream fix'):
                        recipe.verify_inputs(root)

    def test_input_mutation_and_oversize_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'input'
            path.write_bytes(b'good')
            locked = {'filename': 'input', 'size': 4, 'sha256': hashlib.sha256(b'good').hexdigest()}
            recipe.verify_file(path, locked)
            for changed in (b'evil', b'goodextra'):
                path.write_bytes(changed)
                with self.assertRaises(ValueError):
                    recipe.verify_file(path, locked)

    def test_archive_rejects_traversal_and_links_before_writes(self):
        for name, link in (('../escape', False), ('link', True)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / 'bad.tar'
                with tarfile.open(archive, 'w') as output:
                    good = tarfile.TarInfo('good')
                    good.size = 4
                    output.addfile(good, io.BytesIO(b'good'))
                    bad = tarfile.TarInfo(name)
                    if link:
                        bad.type = tarfile.SYMTYPE
                        bad.linkname = '/outside'
                    output.addfile(bad)
                with self.assertRaises(ValueError):
                    recipe.extract_regular(archive, root / 'output')
                self.assertFalse((root / 'output/good').exists())
                self.assertFalse((root / 'escape').exists())

    def test_hostile_member_types_names_duplicates_and_parent_conflicts(self):
        cases = [('/absolute', tarfile.REGTYPE), ('a/../escape', tarfile.REGTYPE),
                 ('a//alias', tarfile.REGTYPE), ('a/./alias', tarfile.REGTYPE),
                 ('a\\escape', tarfile.REGTYPE), ('hard', tarfile.LNKTYPE),
                 ('fifo', tarfile.FIFOTYPE), ('device', tarfile.CHRTYPE),
                 ('good', tarfile.REGTYPE), ('good/child', tarfile.REGTYPE)]
        for name, kind in cases:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / 'hostile.tar'
                with tarfile.open(archive, 'w') as output:
                    good = tarfile.TarInfo('good')
                    good.size = 4
                    output.addfile(good, io.BytesIO(b'good'))
                    bad = tarfile.TarInfo(name)
                    bad.type = kind
                    bad.linkname = '/outside'
                    output.addfile(bad)
                with self.assertRaises(ValueError):
                    recipe.extract_regular(archive, root / 'output')
                self.assertEqual(list((root / 'output').iterdir()), [])

    def test_symlink_injection_after_validation_does_not_write_outside(self):
        for injected in ('source', 'parent'):
            with self.subTest(injected=injected), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                outside = root / 'outside'
                outside.mkdir()
                marker = outside / 'source'
                marker.write_bytes(b'preserve')
                archive = root / 'valid.tar'
                with tarfile.open(archive, 'w') as output:
                    info = tarfile.TarInfo('parent/source')
                    info.size = 4
                    output.addfile(info, io.BytesIO(b'evil'))
                original_open = os.open
                fired = []

                def inject(name, flags, *args, **kwargs):
                    if name == injected and not fired:
                        fired.append(name)
                        parent = kwargs['dir_fd']
                        if name == 'parent':
                            os.rmdir(name, dir_fd=parent)
                            target = outside
                        else:
                            target = marker
                        os.symlink(str(target), name, dir_fd=parent)
                    return original_open(name, flags, *args, **kwargs)

                with patch.object(recipe.os, 'open', side_effect=inject):
                    with self.assertRaises(OSError):
                        recipe.extract_regular(archive, root / 'output')
                self.assertEqual(fired, [injected])
                self.assertEqual(marker.read_bytes(), b'preserve')
                self.assertEqual(list(outside.iterdir()), [marker])

    def test_archive_privileged_modes_are_not_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'mode.tar'
            with tarfile.open(archive, 'w') as output:
                for name, mode in (('configure', 0o6777), ('source', 0o666)):
                    info = tarfile.TarInfo(name)
                    info.mode = mode
                    info.size = 4
                    output.addfile(info, io.BytesIO(b'data'))
            recipe.extract_regular(archive, root / 'output')
            self.assertEqual((root / 'output').stat().st_mode & 0o7777, 0o700)
            self.assertEqual((root / 'output/configure').stat().st_mode & 0o7777, 0o700)
            self.assertEqual((root / 'output/source').stat().st_mode & 0o7777, 0o600)

    def test_regular_archive_and_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'ok.tar'
            with tarfile.open(archive, 'w') as output:
                info = tarfile.TarInfo('dir/source')
                info.size = 4
                output.addfile(info, io.BytesIO(b'good'))
            recipe.extract_regular(archive, root / 'output')
            self.assertEqual((root / 'output/dir/source').read_bytes(), b'good')
            with self.assertRaises(FileExistsError):
                recipe.extract_regular(archive, root / 'output')

    def test_candidate_build_is_offline_repair_then_hidden_prefix_smoke(self):
        script = (ROOT / 'build.sh').read_text()
        self.assertIn('--disable-network', script)
        self.assertIn('--disable-everything', script)
        self.assertIn('--no-build-isolation --no-deps --no-index', script)
        self.assertLess(script.index('auditwheel repair'), script.index('mv /opt/ffmpeg'))
        self.assertLess(script.index('mv /opt/ffmpeg'), script.index('python /out/verify.py'))


class NativeVerificationTests(unittest.TestCase):
    def test_reviewed_guard_pin_matches_production_source_and_lock(self):
        source = ROOT.parents[1] / 'whisper/audio_guard.py'
        production_lock = ROOT.parents[3] / 'charts/videoq-inference/files/vllm-audio-wheels.json'
        self.assertEqual(verify.REVIEWED_GUARD_SHA256, recipe.digest(source))
        self.assertEqual(verify.REVIEWED_GUARD_SHA256,
                         json.loads(production_lock.read_text())['runtimeGuardSha256'])
        verify.verify_serving_guard(source)

    def test_guard_mutation_and_old_source_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'sitecustomize.py'
            path.write_bytes(b'unknown or stale adapter')
            with self.assertRaisesRegex(ValueError, 'Unreviewed serving audio adapter'):
                verify.verify_serving_guard(path)
            with patch.object(verify, 'sha', return_value='ea09f7753f1ad771f9d7acc6b1a33289e20b6f59e83ac367e03513ffb3a2bb5a'):
                with self.assertRaisesRegex(ValueError, 'Unreviewed serving audio adapter'):
                    verify.verify_serving_guard(path)

    def test_members_reject_unknown_changed_and_missing_native_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'av.libs').mkdir()
            path = root / 'av.libs/libavutil-test.so'
            path.write_bytes(b'ELF')
            expected = {'av.libs/libavutil-test.so': hashlib.sha256(b'ELF').hexdigest()}
            self.assertEqual(verify.verify_members(root, expected), expected)
            path.write_bytes(b'evil')
            with self.assertRaises(ValueError):
                verify.verify_members(root, expected)
            path.unlink()
            with self.assertRaises(FileNotFoundError):
                verify.verify_members(root, expected)

    def test_protocol_and_muxer_native_registry_fail_closed(self):
        library = Mock()
        library.avio_enum_protocols.side_effect = [b'file', b'pipe', None, b'file', b'pipe', None]
        library.av_muxer_iterate.return_value = None
        self.assertEqual(verify.protocols(library), {'0': ['file', 'pipe'], '1': ['file', 'pipe']})
        library.avio_enum_protocols.side_effect = [b'http', None, None]
        with self.assertRaisesRegex(ValueError, 'network protocol'):
            verify.protocols(library)
        library.avio_enum_protocols.side_effect = [b'file', b'pipe', None, None]
        library.av_muxer_iterate.return_value = ctypes.c_void_p(1)
        with self.assertRaisesRegex(ValueError, 'output muxer'):
            verify.protocols(library)

    def test_loaded_closure_rejects_same_directory_unknown_native_member(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            native = site / 'av.libs/libavcodec-unknown.so'
            native.parent.mkdir()
            native.write_bytes(b'ELF')
            maps = f'1000-2000 r-xp 0 00:00 0 {native}\n'
            with patch.object(Path, 'read_text', return_value=maps):
                with self.assertRaisesRegex(ValueError, 'Unknown or changed'):
                    verify.loaded_closure(site, {})
                expected = {'av.libs/libavcodec-unknown.so': hashlib.sha256(b'ELF').hexdigest()}
                self.assertEqual(verify.loaded_closure(site, expected), [str(native.resolve())])

    def test_wav_fixtures_have_exact_pcm_contract(self):
        import wave
        for rate, channels in ((16000, 1), (48000, 2)):
            with wave.open(io.BytesIO(verify.wav_fixture(rate, channels))) as source:
                self.assertEqual((source.getframerate(), source.getnchannels(), source.getsampwidth()),
                                 (rate, channels, 2))
                self.assertEqual(source.getnframes(), rate // 10)


if __name__ == '__main__':
    unittest.main()
