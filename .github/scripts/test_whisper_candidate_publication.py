import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publication', Path(__file__).with_name('whisper-candidate-publication.py'))
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)


class PublicationAuthorizationTest(unittest.TestCase):
    def fixture(self):
        run = {'id': publication.RUN, 'head_sha': publication.HEAD, 'run_attempt': 1, 'status': 'completed', 'conclusion': 'success', 'event': 'pull_request', 'path': '.github/workflows/whisper-runtime-candidate.yml', 'head_repository': {'full_name': publication.REPOSITORY}}
        names = ['Build one native image with loaded and immutable OCI exports', 'Verify native ELF provenance and isolated non-root server health', 'Scan the full exact candidate including unfixed vulnerabilities']
        jobs = [{'name': 'Native runtime ' + arch, 'status': 'completed', 'conclusion': 'success', 'run_attempt': 1, 'steps': [{'name': name, 'conclusion': 'success'} for name in names]} for arch in publication.CANDIDATES]
        artifacts = [{'id': c['artifact'], 'expired': False, 'digest': c['archiveDigest'], 'name': f'whisper-runtime-image-{arch}-{publication.SOURCE}-1'} for arch,c in publication.CANDIDATES.items()]
        return run, jobs, artifacts

    def test_exact_successful_attempt_required(self):
        fixture = self.fixture()
        self.assertEqual(len(publication.validate_run(*fixture)), 2)
        for field, value in [('head_sha', '0' * 40), ('run_attempt', 2), ('status', 'in_progress'), ('conclusion', 'failure'), ('event', 'workflow_run'), ('path', 'other.yml')]:
            run, jobs, artifacts = copy.deepcopy(fixture); run[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): publication.validate_run(run, jobs, artifacts)
        for control in ['job-skipped','step-skipped','job-attempt','missing-job','artifact-digest','expired','artifact-id']:
            run, jobs, artifacts = copy.deepcopy(fixture)
            if control == 'job-skipped': jobs[0]['conclusion'] = 'skipped'
            if control == 'step-skipped': jobs[0]['steps'][1]['conclusion'] = 'skipped'
            if control == 'job-attempt': jobs[0]['run_attempt'] = 2
            if control == 'missing-job': jobs.pop()
            if control == 'artifact-digest': artifacts[0]['digest'] = 'sha256:' + '0' * 64
            if control == 'expired': artifacts[0]['expired'] = True
            if control == 'artifact-id': artifacts[0]['id'] += 1
            with self.subTest(control=control), self.assertRaises(ValueError): publication.validate_run(run, jobs, artifacts)

    def test_changed_or_external_native_receipts_rejected_before_content_processing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'identity.json').write_text('{}')
            with self.assertRaisesRegex(ValueError, 'differs from reviewed'):
                publication.validate_artifact(root, 'amd64')
            (root/'identity.json').unlink(); (root/'identity.json').symlink_to('/etc/hosts')
            with self.assertRaisesRegex(ValueError, 'external'):
                publication.validate_artifact(root, 'amd64')
