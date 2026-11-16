from pathlib import Path
import tempfile
import unittest
from d1_resource_transfer_control import TransferControl
from d1_resource_transfer_journal import TransferJournal
from d1_resource_transfer_api import TransferApi


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.journal = TransferJournal(str(Path(self.directory.name)), 'a' * 32, 'b' * 40, 'c' * 64)
        self.calls, self.file, self.lost, self.changed = [], None, None, False
        outer = self
        class Api:
            bookmark = staticmethod(TransferApi.bookmark)
            def export(self, bookmark=None):
                outer.calls.append(('export', bookmark))
                if outer.lost == 'export':
                    raise OSError('lost')
                return {'success': True, 'type': 'export', 'at_bookmark': 'export-1', **({'status': 'complete', 'result': {'signed_url': 'private-url'}} if bookmark else {})}
            def init_import(self, etag):
                outer.calls.append(('init', etag))
                return {'filename': 'file.sql', 'upload_url': 'private-upload-url'}
            def ingest(self, etag, filename):
                outer.calls.append(('ingest', etag))
                if outer.lost == 'ingest':
                    raise OSError('lost')
                return {'success': True, 'type': 'import', 'at_bookmark': 'import-1'}
            def poll_import(self, bookmark):
                outer.calls.append(('poll', bookmark))
                return {'success': True, 'type': 'import', 'at_bookmark': bookmark, 'status': 'complete'}
        class Files:
            def inspect(self):
                if outer.file is None:
                    raise FileNotFoundError()
                return outer.file
            def download(self, url, owned):
                outer.calls.append(('download', None))
                outer.file = {'sha256': 'd' * 64, 'md5': 'e' * 32, 'bytes': 12}
                return outer.file
            def upload(self, url, proof, owned):
                outer.calls.append(('upload', proof['md5']))
        self.api, self.files = Api(), Files()
        self.control = TransferControl(self.journal, self.api, self.files,
                                       lambda proof: {'verified': True, 'ownerFenceVerified': True, 'fileSha256': proof['sha256']},
                                       lambda: {'verified': not self.changed}, lambda: None)

    def run_until(self, phase):
        for _ in range(20):
            result = self.control.run_next()
            if result['phase'] == phase:
                return result
        self.fail('phase not reached')

    def test_full_pipeline_persists_stage_before_mutation_and_verifies_target(self):
        result = self.run_until('database-verified')
        self.assertTrue(result['databaseVerified'])
        self.assertEqual([call[0] for call in self.calls], ['export', 'export', 'download', 'init', 'upload', 'ingest', 'poll'])
        before = list(self.calls)
        self.assertTrue(self.control.run_next()['databaseVerified'])
        self.assertEqual(self.calls, before)
        self.changed = True
        with self.assertRaisesRegex(ValueError, 'PROOF_CHANGED'):
            self.control.run_next()

    def test_lost_initial_export_retains_intent_and_never_starts_another(self):
        self.lost = 'export'
        with self.assertRaises(OSError):
            self.control.run_next()
        self.assertEqual(self.journal.read()[-1]['phase'], 'export-intent')
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            self.control.run_next()
        self.assertEqual(len(self.calls), 1)

    def test_lost_ingest_retains_intent_and_never_reingests(self):
        self.run_until('uploaded')
        self.lost = 'ingest'
        with self.assertRaises(OSError):
            self.control.run_next()
        self.assertEqual(self.journal.read()[-1]['phase'], 'ingest-intent')
        with self.assertRaisesRegex(ValueError, 'RECONCILIATION'):
            self.control.run_next()
        self.assertEqual(sum(call[0] == 'ingest' for call in self.calls), 1)

    def test_changed_file_stops_before_import(self):
        self.run_until('dump-verified')
        self.file = {**self.file, 'sha256': 'f' * 64}
        with self.assertRaisesRegex(ValueError, 'FILE_CHANGED'):
            self.control.run_next()
        self.assertFalse(any(call[0] == 'init' for call in self.calls))

    def test_negative_verification_cannot_be_recorded_as_success(self):
        self.run_until('downloaded')
        self.control.validate_dump = lambda proof: {'verified': False}
        with self.assertRaisesRegex(ValueError, 'DUMP_PROOF_REQUIRED'):
            self.control.run_next()
        self.assertEqual(self.journal.read()[-1]['phase'], 'downloaded')

    def test_export_poll_rejects_replaced_operation_bookmark(self):
        self.control.run_next()
        self.api.export = lambda bookmark: {'success': True, 'type': 'export', 'at_bookmark': 'other'}
        with self.assertRaisesRegex(ValueError, 'BOOKMARK_CHANGED'):
            self.control.run_next()
        self.assertEqual(self.journal.read()[-1]['phase'], 'export-handle')


if __name__ == '__main__':
    unittest.main()
