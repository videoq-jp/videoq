import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import image_store as m


def images():
    return {name: {'repository': 'ghcr.io/videoq-jp/videoq-' + name, 'digest': 'sha256:' + 'a' * 64}
            for name in m.COMPONENTS}


class StoreTests(unittest.TestCase):
    def test_local_complete_graph_is_reused_without_any_upstream_request(self):
        with patch.object(m, 'verify_local') as verify, patch.object(m.subprocess, 'run') as run:
            self.assertEqual(len(m.preserve(images())), 4)
            self.assertEqual(verify.call_count, 4)
            run.assert_not_called()

    def test_partial_graph_is_copied_then_reverified_before_acceptance(self):
        calls = []
        def verify(ref):
            calls.append(ref)
            if len(calls) == 1:
                raise subprocess.CalledProcessError(1, 'oras')
        with patch.object(m, 'verify_local', side_effect=verify), patch.object(m.subprocess, 'run') as run:
            m.preserve(images())
        self.assertEqual(run.call_count, 1)
        self.assertIn('--recursive', run.call_args.args[0])
        self.assertIn('--to-plain-http', run.call_args.args[0])
        self.assertEqual(calls[0], calls[1])

    def test_invalid_image_set_fails_before_network_or_writes(self):
        for bad in [{}, {**images(), 'api': {'repository': 'evil.example/image', 'digest': 'sha256:' + 'a'*64}},
                    {**images(), 'api': {'repository': 'ghcr.io/videoq-jp/videoq-api', 'digest': 'latest'}}]:
            with patch.object(m, 'verify_local') as verify:
                with self.assertRaises(ValueError): m.preserve(bad)
                verify.assert_not_called()

    def site(self, root):
        site = root / 'site'; (site / 'videoq').mkdir(parents=True)
        resources = json.dumps({'items': [{'kind': 'Deployment', 'spec': {'template': {'spec': {'containers': [
            {'image': r} for r in m.application_refs(images())]}}}}]}).encode()
        (site / 'videoq/resources.json').write_bytes(resources)
        lock = {'sourceSha': 'b'*40, 'runId': '123', 'runAttempt': 1, 'applicationImages': images(),
                'renderedFilesSha256': {'videoq/resources.json': hashlib.sha256(resources).hexdigest()}}
        (site / 'release-lock.json').write_text(json.dumps(lock))
        return site

    def test_failed_copy_leaves_no_success_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); site = self.site(root)
            with patch.object(m, 'preserve', side_effect=ValueError('missing upstream')):
                with self.assertRaises(ValueError): m.stage(site, root/'store')
            self.assertFalse((root/'store').exists())

    def test_tampered_resources_fail_before_fetch_and_completed_stage_is_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); site = self.site(root)
            with patch.object(m, 'preserve') as preserve:
                receipt = m.stage(site, root/'store')
                self.assertEqual(preserve.call_args.args[0], images())
            paths = list((root/'store/releases').glob('*.json'))
            self.assertEqual(len(paths), 1)
            self.assertEqual(paths[0].stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(paths[0].read_text()), receipt)
            (site/'videoq/resources.json').write_text('{}')
            with patch.object(m, 'preserve') as preserve:
                with self.assertRaises(ValueError): m.stage(site, root/'store')
                preserve.assert_not_called()

    def test_digest_equality_and_full_graph_are_required(self):
        ref = m.local_ref(m.application_refs(images())[0])
        with patch.object(m, 'descriptor', return_value='sha256:' + 'b'*64), patch.object(m.subprocess, 'run') as run:
            with self.assertRaises(ValueError): m.verify_local(ref)
            run.assert_not_called()
        with patch.object(m, 'descriptor', return_value='sha256:' + 'a'*64), patch.object(m.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'missing blob')):
            with self.assertRaises(subprocess.CalledProcessError): m.verify_local(ref)


if __name__ == '__main__': unittest.main()
