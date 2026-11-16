"""Local kernel lock for one coordinator's private artifact directory.

The distributed run must also be claimed via the AWS executor token. Never
unlink the lock file: stale processes keep their descriptor, and deleting it
would permit a second inode to be locked concurrently.
"""
import fcntl
import os
import stat
from d1_resource_files import PrivateSqlFiles


class ExecutorLock:
    def __init__(self, directory):
        self.files = PrivateSqlFiles(directory)
        self.fd = None

    def __enter__(self):
        if self.fd is not None:
            raise ValueError('RESOURCE_EXECUTOR_ALREADY_ENTERED')
        self.files.checked()
        fd = os.open(self.files.root / 'executor.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
                raise ValueError('RESOURCE_EXECUTOR_LOCK_UNSAFE')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise ValueError('RESOURCE_EXECUTOR_BUSY') from None
        except Exception:
            os.close(fd)
            raise
        self.fd = fd
        try:
            self.check()
        except Exception:
            self.__exit__()
            raise
        return self

    def check(self):
        if self.fd is None:
            raise ValueError('RESOURCE_EXECUTOR_LOCK_REQUIRED')
        self.files.checked()
        current = os.stat(self.files.root / 'executor.lock', follow_symlinks=False)
        held = os.fstat(self.fd)
        if (not stat.S_ISREG(current.st_mode) or stat.S_IMODE(current.st_mode) != 0o600
                or (current.st_dev, current.st_ino) != (held.st_dev, held.st_ino)):
            raise ValueError('RESOURCE_EXECUTOR_LOCK_REPLACED')

    def __exit__(self, *_exception):
        if self.fd is not None:
            fd, self.fd = self.fd, None
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)
