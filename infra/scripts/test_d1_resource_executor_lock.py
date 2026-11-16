import os
from pathlib import Path
import tempfile
import unittest
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
        os.chmod(self.root / 'executor.lock', 0o644)
        with self.assertRaisesRegex(ValueError, 'UNSAFE'):
            ExecutorLock(str(self.root)).__enter__()


if __name__ == '__main__':
    unittest.main()
