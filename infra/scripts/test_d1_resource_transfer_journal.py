import json
import os
from pathlib import Path
import tempfile
import unittest
from d1_resource_transfer_journal import TransferJournal, PHASES


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.journal = self.reopen()

    def reopen(self, source='b' * 40):
        return TransferJournal(str(self.root), 'a' * 32, source, 'c' * 64)

    def test_records_survive_reopening_and_preserve_exact_order_and_proofs(self):
        for phase in PHASES:
            self.journal.save(phase, {'receipt': phase})
            self.assertEqual(self.reopen().read()[-1]['phase'], phase)
        self.assertEqual(len(self.journal.read()), len(PHASES))
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in self.root.iterdir()))
        self.journal.save(PHASES[0], {'receipt': PHASES[0]})
        with self.assertRaisesRegex(ValueError, 'PROOF_CHANGED'):
            self.journal.save(PHASES[0], {'receipt': 'changed'})

    def test_missing_initial_intent_or_missing_middle_record_refuses_recovery(self):
        with self.assertRaisesRegex(ValueError, 'ORDER_REQUIRED'):
            self.journal.save(PHASES[1], {})
        for phase in PHASES[:3]:
            self.journal.save(phase, {})
        (self.root / self.journal.filename(1)).unlink()
        with self.assertRaisesRegex(ValueError, 'GAP'):
            self.reopen().read()

    def test_corrupt_or_partial_record_and_changed_context_are_never_repaired(self):
        self.journal.save(PHASES[0], {'operationId': 'original'})
        with self.assertRaisesRegex(ValueError, 'CORRUPT'):
            self.reopen(source='d' * 40).read()
        path = self.root / self.journal.filename(0)
        original = json.loads(path.read_text())
        original['value']['operationId'] = 'forged'
        path.write_text(json.dumps(original))
        with self.assertRaisesRegex(ValueError, 'CORRUPT'):
            self.journal.read()
        path.write_text('{')
        with self.assertRaisesRegex(ValueError, 'CORRUPT'):
            self.journal.save(PHASES[0], {})
        self.assertEqual(path.read_text(), '{')

    def test_public_or_symlink_record_refuses_reads(self):
        self.journal.save(PHASES[0], {})
        path = self.root / self.journal.filename(0)
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'UNSAFE'):
            self.journal.read()
        path.unlink()
        path.symlink_to('/dev/null')
        with self.assertRaises(OSError):
            self.journal.read()

    def test_directory_identity_and_permissions_are_pinned(self):
        self.root.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'DIRECTORY_CHANGED'):
            self.journal.save(PHASES[0], {})
        self.root.chmod(0o700)
        old = self.root.with_name(self.root.name + '-old')
        self.root.rename(old)
        self.addCleanup(lambda: old.rmdir())
        self.root.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, 'DIRECTORY_CHANGED'):
            self.journal.read()


if __name__ == '__main__':
    unittest.main()
