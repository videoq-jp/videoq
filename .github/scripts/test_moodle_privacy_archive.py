import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

SOURCE = Path(__file__).resolve().parents[1] / 'moodle-cpu/privacy-archive.py'
SPEC = importlib.util.spec_from_file_location('privacy_archive', SOURCE)
archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive)


class MoodlePrivacyArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'private.zip'
        self.expected = {'context': '4', 'conversationId': '11111111-1111-4111-8111-111111111111',
                         'records': {key: [{'conversationId': '11111111-1111-4111-8111-111111111111',
                                           'namespace': '', 'privateValue': 'PRIVATE_MODEL_BYTES_日本語'}]
                                     for key in archive.COLLECTIONS}}

    def write(self, values=None, fragment=False):
        values = values or self.expected
        with zipfile.ZipFile(self.path, 'w') as output:
            for collection, rows in values['records'].items():
                base = 'VideoQ/installation/context/' + collection + '/'
                if not fragment:
                    output.writestr(base + 'records-1.ndjson', '\n'.join(json.dumps({
                        'id': str(index), 'context': values['context'], 'data': row}) for index, row in enumerate(rows)))
                else:
                    for index, row in enumerate(rows, 1):
                        text = json.dumps(row, ensure_ascii=False)
                        chunks = [text[:len(text)//2], text[len(text)//2:]]
                        for part, chunk in enumerate(chunks, 1):
                            output.writestr(base + str(index) + '-part-' + str(part) + '.txt', chunk)
                        output.writestr(base + str(index) + '-manifest.json', json.dumps({
                            'context': values['context'], 'fragments': len(chunks), 'encoding': 'UTF-8',
                            'characters': len(text), 'sha256': hashlib.sha256(text.encode()).hexdigest()}))

    def test_complete_model_payloads_match_without_returning_private_records(self):
        self.write()
        result = archive.verify_archive(self.path, self.expected)
        self.assertEqual(result['counts'], {key: 1 for key in archive.COLLECTIONS})
        self.assertTrue(result['modelRecordsMatched'])
        self.assertEqual(result['archiveSha256'], hashlib.sha256(self.path.read_bytes()).hexdigest())
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_fragmented_utf8_records_are_reassembled_before_comparison(self):
        self.write(fragment=True)
        self.assertTrue(archive.verify_archive(self.path, self.expected)['modelRecordsMatched'])
        with zipfile.ZipFile(self.path, 'a') as output:
            output.writestr('VideoQ/installation/context/checkpoints/1-part-3.txt', 'PRIVATE_UNREFERENCED')
        with self.assertRaises(ValueError):
            archive.verify_archive(self.path, self.expected)

    def test_changed_missing_extra_or_foreign_model_data_fails(self):
        for field, value in [('privateValue', 'PRIVATE_CHANGED'), ('namespace', 'other'),
                             ('conversationId', '22222222-2222-4222-8222-222222222222')]:
            values = copy.deepcopy(self.expected)
            values['records']['checkpoint_blobs'][0][field] = value
            self.write(values)
            with self.assertRaises(ValueError):
                archive.verify_archive(self.path, self.expected)
        for rows in [[], self.expected['records']['checkpoint_writes'] * 2]:
            values = copy.deepcopy(self.expected)
            values['records']['checkpoint_writes'] = rows
            self.write(values)
            with self.assertRaises(ValueError):
                archive.verify_archive(self.path, self.expected)
        values = copy.deepcopy(self.expected)
        values['context'] = '5'
        self.write(values)
        with self.assertRaises(ValueError):
            archive.verify_archive(self.path, self.expected)

    def test_corrupt_fragment_checksum_fails(self):
        self.write(fragment=True)
        with zipfile.ZipFile(self.path) as source:
            entries = {member.filename: source.read(member) for member in source.infolist()}
        name = 'VideoQ/installation/context/checkpoints/1-manifest.json'
        manifest = json.loads(entries[name])
        manifest['sha256'] = '0' * 64
        entries[name] = json.dumps(manifest).encode()
        with zipfile.ZipFile(self.path, 'w') as output:
            for name, data in entries.items():
                output.writestr(name, data)
        with self.assertRaises(ValueError):
            archive.verify_archive(self.path, self.expected)

    def test_cli_failure_never_prints_private_input_archive_or_path(self):
        self.write()
        wrong = copy.deepcopy(self.expected)
        wrong['records']['checkpoints'][0]['privateValue'] = 'PRIVATE_DO_NOT_PRINT'
        result = subprocess.run([sys.executable, str(SOURCE), str(self.path)], input=json.dumps(wrong),
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {'status': 'failed'})
        self.assertEqual(result.stderr, '')
        self.assertNotIn('PRIVATE', result.stdout)
        self.assertNotIn(str(self.path), result.stdout)


if __name__ == '__main__':
    unittest.main()
