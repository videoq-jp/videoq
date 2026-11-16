import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from d1_resource_files import PrivateSqlFiles, signed_url

URL = 'https://database.example.r2.cloudflarestorage.com/file.sql?signature=synthetic'
DATA = b'CREATE TABLE example(id INTEGER);\n'


class Response(io.BytesIO):
    status = 200
    headers = {'ETag': '"' + hashlib.md5(DATA).hexdigest() + '"'}


class FileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.calls, self.fail = [], False
        outer = self
        class Opener:
            def open(self, request, timeout):
                outer.calls.append(request)
                if outer.fail:
                    raise OSError('PRIVATE_PROVIDER_BODY')
                if request.method == 'PUT':
                    outer.uploaded = request.data.read()
                return Response(DATA)
        self.files = PrivateSqlFiles(str(self.root), Opener())

    def test_private_download_and_upload_match_digest_and_forward_no_bearer_token(self):
        proof = self.files.download(URL, lambda: None)
        self.assertEqual(proof['bytes'], len(DATA))
        self.assertEqual((self.root / 'source.sql').stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root / 'source.sql.partial').exists())
        self.assertTrue(self.files.upload(URL, proof, lambda: None)['uploaded'])
        self.assertEqual(self.uploaded, DATA)
        self.assertTrue(all(request.get_header('Authorization') is None for request in self.calls))

    def test_existing_or_partial_files_are_never_overwritten(self):
        self.files.download(URL, lambda: None)
        with self.assertRaisesRegex(ValueError, 'ALREADY_EXISTS'):
            self.files.download(URL, lambda: None)
        (self.root / 'source.sql').unlink()
        (self.root / 'source.sql.partial').write_bytes(b'private partial')
        with self.assertRaises(FileExistsError):
            self.files.download(URL, lambda: None)
        self.assertEqual((self.root / 'source.sql.partial').read_bytes(), b'private partial')

    def test_network_failure_retains_private_partial_and_does_not_retry(self):
        self.fail = True
        with self.assertRaisesRegex(ValueError, '^RESOURCE_FILE_DOWNLOAD_UNCERTAIN$'):
            self.files.download(URL, lambda: None)
        self.assertFalse((self.root / 'source.sql').exists())
        self.assertEqual((self.root / 'source.sql.partial').stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(self.calls), 1)

    def test_changed_proof_or_lost_ownership_refuses_upload(self):
        proof = self.files.download(URL, lambda: None)
        with self.assertRaisesRegex(ValueError, 'PROOF_CHANGED'):
            self.files.upload(URL, {**proof, 'bytes': 1}, lambda: None)
        def revoked():
            raise ValueError('OWNERSHIP_LOST')
        with self.assertRaisesRegex(ValueError, 'OWNERSHIP'):
            self.files.upload(URL, proof, revoked)
        self.assertEqual(len(self.calls), 1)

    def test_upload_response_loss_is_uncertain_and_does_not_retry(self):
        proof = self.files.download(URL, lambda: None)
        self.fail = True
        with self.assertRaisesRegex(ValueError, '^RESOURCE_FILE_UPLOAD_UNCERTAIN$'):
            self.files.upload(URL, proof, lambda: None)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.files.inspect(), proof)

    def test_untrusted_urls_symlinks_and_public_files_are_refused(self):
        for url in ['http://database.example.r2.cloudflarestorage.com/a?x=1', 'https://evil.invalid/a?x=1', 'https://user@database.example.r2.cloudflarestorage.com/a?x=1', URL + '#fragment']:
            with self.assertRaises(ValueError):
                signed_url(url)
        (self.root / 'source.sql').symlink_to('/dev/null')
        with self.assertRaises(OSError):
            self.files.inspect()
        (self.root / 'source.sql').unlink()
        self.files.download(URL, lambda: None)
        os.chmod(self.root / 'source.sql', 0o644)
        with self.assertRaisesRegex(ValueError, 'UNSAFE'):
            self.files.inspect()


if __name__ == '__main__':
    unittest.main()
