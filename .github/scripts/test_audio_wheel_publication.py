import copy
import importlib.util
import json
import io
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('publication', Path(__file__).with_name('audio-wheel-publication.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AudioPublicationTest(unittest.TestCase):
    def fixture(self):
        policy = json.loads(MODULE.POLICY.read_text())
        policy.update(status='reviewed-corrected-native-proof', run=123, attempt=1, artifact=456,
                      head='a' * 40, source='b' * 40, archiveSha256='c' * 64,
                      wheelSha256=MODULE.sha(b'exact tested wheel'), wheelSize=len(b'exact tested wheel'),
                      evidenceHashes={name: 'd' * 64 for name in MODULE.EVIDENCE})
        run = {'id': 123, 'head_sha': policy['head'], 'run_attempt': 1, 'status': 'completed',
               'conclusion': 'success', 'event': 'pull_request',
               'path': '.github/workflows/patched-audio-candidate.yml',
               'head_repository': {'full_name': MODULE.REPOSITORY}}
        jobs = [{'name': 'native-source', 'status': 'completed', 'conclusion': 'success', 'run_attempt': 1,
                 'steps': [{'name': name, 'conclusion': 'success'} for name in MODULE.GATES]}]
        artifacts = [{'id': 456, 'expired': False, 'digest': 'sha256:' + policy['archiveSha256'],
                      'name': f"patched-audio-candidate-{policy['source']}-1"}]
        return policy, run, jobs, artifacts

    def test_unconfigured_policy_cannot_publish(self):
        with self.assertRaisesRegex(ValueError, 'disabled'):
            MODULE.approved(dict(json.loads(MODULE.POLICY.read_text()), status='awaiting-corrected-native-proof'))
        policy, *_ = self.fixture()
        for key, value in [('repository', 'other/repo'), ('releaseTag', 'existing-release'),
                           ('wheelSha256', None), ('attempt', 0), ('evidenceHashes', {})]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                MODULE.approved(dict(policy, **{key: value}))

    def test_every_gate_attempt_and_artifact_must_match(self):
        MODULE.validate_run(*self.fixture())
        for control in ['failed-run', 'wrong-head', 'wrong-attempt', 'wrong-workflow',
                        'skipped-step', 'missing-step', 'duplicate-job', 'expired', 'wrong-digest']:
            policy, run, jobs, artifacts = copy.deepcopy(self.fixture())
            if control == 'failed-run':
                run['conclusion'] = 'failure'
            elif control == 'wrong-head':
                run['head_sha'] = 'e' * 40
            elif control == 'wrong-attempt':
                jobs[0]['run_attempt'] = 2
            elif control == 'wrong-workflow':
                run['event'] = 'workflow_run'
            elif control == 'skipped-step':
                jobs[0]['steps'][4]['conclusion'] = 'skipped'
            elif control == 'missing-step':
                jobs[0]['steps'].pop()
            elif control == 'duplicate-job':
                jobs.append(copy.deepcopy(jobs[0]))
            elif control == 'expired':
                artifacts[0]['expired'] = True
            else:
                artifacts[0]['digest'] = 'sha256:' + '0' * 64
            with self.subTest(control=control), self.assertRaises(ValueError):
                MODULE.validate_run(policy, run, jobs, artifacts)

    def test_collision_and_operational_error_never_authorize_replacement(self):
        for code in [403, 429, 500]:
            error = urllib.error.HTTPError('https://api.github.com', code, 'failure', {}, None)
            with patch.object(MODULE.urllib.request, 'urlopen', side_effect=error), self.assertRaises(urllib.error.HTTPError):
                MODULE.require_absent('releases/tags/' + MODULE.RELEASE_TAG)
        error = urllib.error.HTTPError('https://api.github.com', 404, 'missing', {}, None)
        with patch.object(MODULE.urllib.request, 'urlopen', side_effect=error):
            MODULE.require_absent('releases/tags/' + MODULE.RELEASE_TAG)
        with patch.object(MODULE.urllib.request, 'urlopen'), self.assertRaisesRegex(ValueError, 'already exists'):
            MODULE.require_absent('releases/tags/' + MODULE.RELEASE_TAG)

    def test_writer_only_executes_reviewed_workflow_source_after_read_only_validation(self):
        workflow = (MODULE.POLICY.parents[1] / 'workflows/audio-wheel-publish.yml').read_text()
        self.assertNotIn('pull_request_target', workflow)
        self.assertNotIn('packages: write', workflow)
        self.assertIn('needs: validate', workflow)
        self.assertIn("github.ref == 'refs/tags/" + MODULE.PUBLISHER_TAG + "'", workflow)
        self.assertEqual(workflow.count('ref: ${{ github.workflow_sha }}'), 3)
        self.assertEqual(workflow.count('contents: write'), 1)

    def native_fixture(self):
        content = {'av/__init__.py': b'# fixture', 'av.libs/libavcodec-test.so.63': b'ELF fixture',
                   'av-19.0.2.dist-info/METADATA': b'Name: av'}
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as wheel:
            wheel.writestr('av/', b'')
            for name, data in content.items():
                wheel.writestr(name, data)
        members = {name: MODULE.sha(data) for name, data in content.items()}
        installed = {name: digest for name, digest in members.items() if name.startswith(('av/', 'av.libs/'))}
        native = {'status': 'passed', 'ffmpegVersion': '9.1', 'pyavVersion': '19.0.2',
                  'installedMemberCount': len(installed),
                  'compiledFilters': ['abuffer', 'abuffersink', 'aformat', 'aresample', 'buffer', 'buffersink'],
                  'compiledDecoders': ['flac', 'mp3', 'mp3float', 'pcm_s16le'], 'compiledEncoders': [],
                  'nativeMuxers': [], 'nativeProtocols': {'0': ['file', 'pipe'], '1': ['file', 'pipe']},
                  'loadedCandidateElfs': ['/opt/videoq-audio/av.libs/libavcodec-test.so.63']}
        names = ['pcm16-16k-mono', 'pcm16-48k-stereo', 'extra_overread.mp3', 'luckynight.flac']
        native['decodeResample'] = [{'fixture': name, 'samples16kMono': 1600} for name in names]
        native['whisperPreprocessing'] = [{'fixture': name, 'samples': 1600, 'duration': 0.1} for name in names]
        native['decodeResample'][2]['samples16kMono'] = 160079
        native['whisperPreprocessing'][2].update(samples=159887, duration=9.9929375)
        return stream.getvalue(), {'wheel': {'members': members}}, native, {'overlayFiles': installed}

    def test_wheel_members_installed_subset_and_native_semantics_bound_separately(self):
        MODULE.validate_members_and_native(*self.native_fixture())
        for control in ['member', 'installed', 'count', 'loaded', 'filters', 'short-pcm', 'empty-serving']:
            wheel, provenance, native, identity = copy.deepcopy(self.native_fixture())
            if control == 'member':
                provenance['wheel']['members']['av/__init__.py'] = '0' * 64
            elif control == 'installed':
                identity['overlayFiles'].clear()
            elif control == 'count':
                native['installedMemberCount'] = len(provenance['wheel']['members'])
            elif control == 'loaded':
                native['loadedCandidateElfs'] = ['/usr/lib/libavcodec.so']
            elif control == 'filters':
                native['compiledFilters'].append('azmq')
            elif control == 'short-pcm':
                native['whisperPreprocessing'][1]['samples'] = 1584
            else:
                native['whisperPreprocessing'] = []
            with self.subTest(control=control), self.assertRaises(ValueError):
                MODULE.validate_members_and_native(wheel, provenance, native, identity)

    def test_exact_archive_and_actual_native_receipt_are_required(self):
        policy, *_ = self.fixture()
        files = {name: b'{}' for name in MODULE.EVIDENCE}
        files['audio-evidence/source.json'] = json.dumps({'source': policy['source'], 'run': '123',
                                                        'attempt': '1', 'architecture': 'x86_64'}).encode()
        wheel, provenance, native, identity = self.native_fixture()
        policy['wheelSha256'] = MODULE.sha(wheel)
        policy['wheelSize'] = len(wheel)
        files['audio-native/native-smoke.json'] = json.dumps(native).encode()
        files['audio-evidence/identity.json'] = json.dumps(identity).encode()
        files['audio-evidence/security.json.grype.json'] = json.dumps({
            'matches': [], 'ignoredMatches': [], 'descriptor': {'db': {'status': {'valid': True}}}}).encode()
        provenance['wheel'].update(sha256=policy['wheelSha256'], filename=MODULE.ASSET)
        files['audio-candidate/provenance.json'] = json.dumps(provenance).encode()
        files['audio-candidate/wheels/' + MODULE.ASSET] = wheel
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'candidate.zip'

            def write():
                with zipfile.ZipFile(archive, 'w') as bundle:
                    for name, value in files.items():
                        bundle.writestr(name, value)
                policy['archiveSha256'] = MODULE.sha(archive.read_bytes())
                policy['evidenceHashes'] = {name: MODULE.sha(files[name]) for name in MODULE.EVIDENCE if name in files}

            write()
            self.assertEqual(MODULE.artifact_bytes(policy, archive), wheel)
            original = dict(files)
            for control in ['missing-native', 'failed-native', 'scan-findings', 'ignored-findings',
                            'invalid-db', 'changed-wheel', 'traversal']:
                files.clear()
                files.update(original)
                if control == 'missing-native':
                    del files['audio-native/native-smoke.json']
                elif control == 'failed-native':
                    files['audio-native/native-smoke.json'] = b'{"status":"failed"}'
                elif control in ['scan-findings', 'ignored-findings', 'invalid-db']:
                    scan = json.loads(files['audio-evidence/security.json.grype.json'])
                    if control == 'invalid-db':
                        scan['descriptor']['db']['status']['valid'] = False
                    else:
                        scan['matches' if control == 'scan-findings' else 'ignoredMatches'] = [{}]
                    files['audio-evidence/security.json.grype.json'] = json.dumps(scan).encode()
                elif control == 'changed-wheel':
                    files['audio-candidate/wheels/' + MODULE.ASSET] = b'rebuilt wheel'
                else:
                    files['../escape'] = b'hostile'
                write()
                with self.subTest(control=control), self.assertRaises(ValueError):
                    MODULE.artifact_bytes(policy, archive)


if __name__ == '__main__':
    unittest.main()
