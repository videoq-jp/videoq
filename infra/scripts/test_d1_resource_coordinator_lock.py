import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from d1_resource_coordinator_lock import CoordinatorLock
from d1_resource_executor_lock import ExecutorLock


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def lock(self, owner='a'):
        return CoordinatorLock(str(self.root), os.getpid(), owner * 64)

    def test_outer_lock_excludes_other_coordinators_but_not_transfer_worker_lock(self):
        with self.lock() as first:
            first.check()
            inode = (self.root / 'coordinator.lock').stat().st_ino
            with ExecutorLock(str(self.root)):
                with self.assertRaisesRegex(ValueError, 'BUSY'):
                    self.lock('b').__enter__()
            first.release()
        with self.lock('c') as second:
            second.check()
            self.assertEqual((self.root / 'coordinator.lock').stat().st_ino, inode)
            second.release()
        self.assertEqual((self.root / 'coordinator.lock').stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.root / 'coordinator.lock.identity').stat().st_mode & 0o777, 0o600)

    def test_abnormal_keeper_exit_preserves_live_parent_marker_until_parent_is_gone(self):
        with self.lock():
            pass
        with self.assertRaisesRegex(ValueError, 'PARENT_STILL_RUNNING'):
            self.lock('b').__enter__()
        with patch('d1_resource_coordinator_lock.parent_alive', return_value=False):
            with self.lock('c') as resumed:
                resumed.check()
                resumed.release()

    def test_replaced_lock_inode_cannot_be_adopted_by_a_new_keeper(self):
        with self.lock() as first:
            (self.root / 'coordinator.lock').rename(self.root / 'original.lock')
            (self.root / 'coordinator.lock').touch(mode=0o600)
            with self.assertRaisesRegex(ValueError, 'REPLACED'):
                first.check()
            with self.assertRaisesRegex(ValueError, 'IDENTITY_CHANGED'):
                self.lock('b').__enter__()

    def test_changed_parent_record_or_identity_never_silently_reacquires(self):
        with self.lock() as first:
            os.pwrite(first.lock.fd, b'private malformed metadata', 0)
            with self.assertRaisesRegex(ValueError, 'RECORD_INVALID'):
                first.check()
        with self.assertRaisesRegex(ValueError, 'RECORD_INVALID'):
            self.lock('b').__enter__()


if __name__ == '__main__':
    unittest.main()
