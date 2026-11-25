import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('whisper-candidate-artifact.py'))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class ArtifactIdentityTest(unittest.TestCase):
    def test_exact_image_required_and_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'blobs/sha256').mkdir(parents=True)

            def write_blob(value):
                data = json.dumps(value).encode()
                digest = hashlib.sha256(data).hexdigest()
                (root / 'blobs/sha256' / digest).write_bytes(data)
                return 'sha256:' + digest

            config = write_blob({'architecture': 'arm64', 'os': 'linux'})
            manifest = write_blob({'config': {'digest': config}})
            (root / 'index.json').write_text(json.dumps({'manifests': [{'digest': manifest}]}))
            with patch.object(candidate.subprocess, 'check_output', return_value=json.dumps([{'Id': config, 'Architecture': 'arm64'}])):
                self.assertTrue(candidate.verify(root, 'candidate', 'arm64')['loadedImageMatches'])
                with self.assertRaisesRegex(ValueError, 'platform mismatch'):
                    candidate.verify(root, 'candidate', 'amd64')
            with patch.object(candidate.subprocess, 'check_output', return_value=json.dumps([{'Id': 'sha256:' + '0' * 64, 'Architecture': 'arm64'}])):
                with self.assertRaisesRegex(ValueError, 'differs'):
                    candidate.verify(root, 'candidate', 'arm64')
            (root / 'blobs/sha256' / manifest.split(':')[1]).write_text('{}')
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                candidate.verify(root, 'candidate', 'arm64')
