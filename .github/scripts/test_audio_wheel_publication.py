import copy
import importlib.util
import json
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
            MODULE.approved(json.loads(MODULE.POLICY.read_text()))
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

    def test_exact_archive_and_actual_native_receipt_are_required(self):
        policy, *_ = self.fixture()
        files = {name: b'{}' for name in MODULE.EVIDENCE}
        files['audio-evidence/source.json'] = json.dumps({'source': policy['source'], 'run': '123',
                                                        'attempt': '1', 'architecture': 'x86_64'}).encode()
        files['audio-native/native-smoke.json'] = json.dumps({'status': 'passed', 'ffmpegVersion': '9.1',
                                                             'pyavVersion': '19.0.2',
                                                             'whisperPreprocessing': [1, 2, 3, 4]}).encode()
        files['audio-evidence/security.json.grype.json'] = json.dumps({
            'matches': [], 'ignoredMatches': [], 'descriptor': {'db': {'status': {'valid': True}}}}).encode()
        files['audio-candidate/provenance.json'] = json.dumps({'wheel': {
            'sha256': policy['wheelSha256'], 'filename': MODULE.ASSET}}).encode()
        files['audio-candidate/wheels/' + MODULE.ASSET] = b'exact tested wheel'
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'candidate.zip'

            def write():
                with zipfile.ZipFile(archive, 'w') as bundle:
                    for name, value in files.items():
                        bundle.writestr(name, value)
                policy['archiveSha256'] = MODULE.sha(archive.read_bytes())
                policy['evidenceHashes'] = {name: MODULE.sha(files[name]) for name in MODULE.EVIDENCE if name in files}

            write()
            self.assertEqual(MODULE.artifact_bytes(policy, archive), b'exact tested wheel')
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
