import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from d1_resource_executor_lock import ExecutorLock


class LockTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_competing_descriptors_cannot_enter_until_first_releases(self):
        first, second = ExecutorLock(str(self.root)), ExecutorLock(str(self.root))
        with first:
            first.check()
            with self.assertRaisesRegex(ValueError, 'BUSY'):
                second.__enter__()
        with second:
            second.check()
        self.assertTrue((self.root / 'executor.lock').exists())
        with self.assertRaisesRegex(ValueError, 'LOCK_REQUIRED'):
            second.check()

    def test_exception_releases_descriptor_without_deleting_lock_inode(self):
        lock = ExecutorLock(str(self.root))
        with self.assertRaises(RuntimeError):
            with lock:
                before = (self.root / 'executor.lock').stat().st_ino
                raise RuntimeError('stop')
        with ExecutorLock(str(self.root)):
            self.assertEqual((self.root / 'executor.lock').stat().st_ino, before)

    def test_replaced_lock_or_public_permissions_refuse_continuation(self):
        with ExecutorLock(str(self.root)) as lock:
            (self.root / 'executor.lock').rename(self.root / 'old.lock')
            (self.root / 'executor.lock').touch(mode=0o600)
            with self.assertRaisesRegex(ValueError, 'REPLACED'):
                lock.check()
        original_fstat = os.fstat
        def public_metadata(fd):
            values = list(original_fstat(fd))
            values[0] = (values[0] & ~0o777) | 0o644
            return os.stat_result(values)
        with patch('d1_resource_executor_lock.os.fstat', side_effect=public_metadata):
            with self.assertRaisesRegex(ValueError, 'UNSAFE'):
                ExecutorLock(str(self.root)).__enter__()
        self.assertEqual((self.root / 'executor.lock').stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
