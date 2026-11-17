from pathlib import Path
import tempfile
import unittest
from d1_resource_executor_lock import ExecutorLock
from d1_resource_worker_lock import ResourceWorkerLock


class WorkerLockTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_worker_mutex_excludes_another_worker_and_keeps_transfer_lock_separate(self):
        with ResourceWorkerLock(str(self.root)) as lock:
            lock.check()
            inode = (self.root / 'resource-worker.lock').stat().st_ino
            with ExecutorLock(str(self.root)):
                with self.assertRaisesRegex(ValueError, 'BUSY'):
                    ResourceWorkerLock(str(self.root)).__enter__()
        with ResourceWorkerLock(str(self.root)) as resumed:
            resumed.check()
            self.assertEqual((self.root / 'resource-worker.lock').stat().st_ino, inode)

    def test_replaced_inode_refuses_both_current_and_next_worker(self):
        with ResourceWorkerLock(str(self.root)) as lock:
            (self.root / 'resource-worker.lock').rename(self.root / 'retained-worker.lock')
            (self.root / 'resource-worker.lock').touch(mode=0o600)
            with self.assertRaisesRegex(ValueError, 'REPLACED'):
                lock.check()
            with self.assertRaisesRegex(ValueError, 'IDENTITY_CHANGED'):
                ResourceWorkerLock(str(self.root)).__enter__()
