"""Shared kernel mutex for the reviewed operator's mutating Python workers.

An idle probe holds the same mutex. It is not an application Lambda invocation
counter. The parent's coordinator lock and durable abort mode exclude new legal
mutators after a successful probe. Lock inode identity survives worker exits.
"""
import json
import os
import stat
from d1_resource_executor_lock import ExecutorLock


class ResourceWorkerLock(ExecutorLock):
    def __init__(self, directory):
        super().__init__(directory, 'resource-worker.lock')

    def identity(self, create=False):
        super().check()
        held = os.fstat(self.fd)
        expected = {'version': 1, 'device': held.st_dev, 'inode': held.st_ino}
        name = self.files.root / 'resource-worker.lock.identity'
        if create:
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError:
                pass
            else:
                try:
                    raw = json.dumps(expected, separators=(',', ':')).encode()
                    if os.write(fd, raw) != len(raw):
                        raise ValueError('RESOURCE_WORKER_IDENTITY_WRITE_FAILED')
                    os.fsync(fd)
                finally:
                    os.close(fd)
                self.files.sync_directory()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_uid != os.getuid() or info.st_size > 4096):
                raise ValueError('RESOURCE_WORKER_IDENTITY_UNSAFE')
            raw = os.read(fd, 4097)
        finally:
            os.close(fd)
        try:
            actual = json.loads(raw)
        except Exception:
            raise ValueError('RESOURCE_WORKER_IDENTITY_INVALID') from None
        if actual != expected:
            raise ValueError('RESOURCE_WORKER_IDENTITY_CHANGED')

    def __enter__(self):
        # ExecutorLock invokes self.check before this first identity creation.
        self.initializing = True
        try:
            super().__enter__()
            self.identity(create=True)
            self.initializing = False
            self.check()
            return self
        except Exception:
            super().__exit__()
            raise

    def check(self):
        if getattr(self, 'initializing', False):
            return super().check()
        return self.identity()
