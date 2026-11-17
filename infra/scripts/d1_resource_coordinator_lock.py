"""Long-lived local coordinator lock over private stdin/stdout, no credentials.

Separate from each transfer worker's executor.lock. The lock inode is retained.
An abnormal keeper exit leaves its parent identity recorded: another keeper
cannot take over while that parent is still alive. This is not the AWS claim.
"""
import json
import os
import re
import stat
import sys
from d1_resource_executor_lock import ExecutorLock

LIMIT = 8192


def parent_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class CoordinatorLock:
    def __init__(self, directory, parent_pid, owner):
        if (type(parent_pid) is not int or parent_pid <= 1 or not isinstance(owner, str)
                or re.fullmatch('[a-f0-9]{64}', owner) is None):
            raise ValueError('RESOURCE_COORDINATOR_CONTEXT_REQUIRED')
        self.lock = ExecutorLock(directory, 'coordinator.lock')
        self.record = {'version': 1, 'parentPid': parent_pid, 'owner': owner, 'state': 'held'}

    def identity(self, create=False):
        self.lock.check()
        held = os.fstat(self.lock.fd)
        wanted = {'version': 1, 'device': held.st_dev, 'inode': held.st_ino}
        name = self.lock.files.root / 'coordinator.lock.identity'
        if create:
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError:
                pass
            else:
                try:
                    raw = json.dumps(wanted, separators=(',', ':')).encode()
                    if os.write(fd, raw) != len(raw):
                        raise ValueError('RESOURCE_COORDINATOR_IDENTITY_WRITE_FAILED')
                    os.fsync(fd)
                finally:
                    os.close(fd)
                self.lock.files.sync_directory()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_uid != os.getuid() or info.st_size > LIMIT):
                raise ValueError('RESOURCE_COORDINATOR_IDENTITY_UNSAFE')
            raw = os.read(fd, LIMIT + 1)
        finally:
            os.close(fd)
        try:
            found = json.loads(raw)
        except Exception:
            raise ValueError('RESOURCE_COORDINATOR_IDENTITY_INVALID') from None
        if found != wanted:
            raise ValueError('RESOURCE_COORDINATOR_IDENTITY_CHANGED')

    def read(self):
        self.identity()
        raw = os.pread(self.lock.fd, LIMIT + 1, 0)
        if not raw:
            return None
        try:
            value = json.loads(raw)
        except Exception:
            raise ValueError('RESOURCE_COORDINATOR_RECORD_INVALID') from None
        if (len(raw) > LIMIT or not isinstance(value, dict)
                or set(value) != {'version', 'parentPid', 'owner', 'state'}
                or type(value['version']) is not int or value['version'] != 1 or type(value['parentPid']) is not int or value['parentPid'] <= 1
                or not isinstance(value['owner'], str) or re.fullmatch('[a-f0-9]{64}', value['owner']) is None
                or value['state'] not in ('held', 'released')):
            raise ValueError('RESOURCE_COORDINATOR_RECORD_INVALID')
        return value

    def write(self, value):
        self.lock.check()
        raw = json.dumps(value, separators=(',', ':')).encode()
        if os.pwrite(self.lock.fd, raw, 0) != len(raw):
            raise ValueError('RESOURCE_COORDINATOR_RECORD_WRITE_FAILED')
        os.ftruncate(self.lock.fd, len(raw))
        os.fsync(self.lock.fd)

    def __enter__(self):
        self.lock.__enter__()
        try:
            self.identity(create=True)
            previous = self.read()
            if previous and previous['state'] == 'held' and parent_alive(previous['parentPid']):
                raise ValueError('RESOURCE_COORDINATOR_PARENT_STILL_RUNNING')
            self.write(self.record)
            self.lock.files.sync_directory()
            self.check()
            return self
        except Exception:
            self.lock.__exit__()
            raise

    def check(self):
        if self.read() != self.record:
            raise ValueError('RESOURCE_COORDINATOR_OWNERSHIP_LOST')

    def release(self):
        self.check()
        self.write({**self.record, 'state': 'released'})
        self.lock.__exit__()

    def __exit__(self, *_exception):
        # Only an explicit release clears the parent marker. EOF, crash or a
        # failed protocol leaves it held until the owning parent has stopped.
        self.lock.__exit__()


def receive():
    raw = sys.stdin.buffer.readline(LIMIT + 1)
    if not raw or len(raw) > LIMIT or not raw.endswith(b'\n'):
        raise ValueError('RESOURCE_COORDINATOR_MESSAGE_REQUIRED')
    return json.loads(raw)


def send(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def main():
    try:
        request = receive()
        if (not isinstance(request, dict) or set(request) != {'version', 'directory', 'parentPid', 'owner'}
                or request['version'] != 1 or request['parentPid'] != os.getppid()):
            raise ValueError('RESOURCE_COORDINATOR_PARENT_REQUIRED')
        with CoordinatorLock(request['directory'], request['parentPid'], request['owner']) as lock:
            send({'event': 'ready', 'owner': request['owner']})
            for sequence in range(1, 1000001):
                message = receive()
                if (not isinstance(message, dict) or set(message) != {'action', 'sequence', 'owner'}
                        or message['sequence'] != sequence or message['owner'] != request['owner']
                        or message['action'] not in ('check', 'release')):
                    raise ValueError('RESOURCE_COORDINATOR_PROTOCOL_REQUIRED')
                lock.check()
                if message['action'] == 'release':
                    lock.release()
                    send({'event': 'released', 'sequence': sequence, 'owner': request['owner']})
                    return 0
                send({'event': 'checked', 'sequence': sequence, 'owner': request['owner']})
            raise ValueError('RESOURCE_COORDINATOR_SEQUENCE_LIMIT')
    except Exception as error:
        code = str(error)
        send({'event': 'error', 'code': code if re.fullmatch('RESOURCE_[A-Z0-9_]+', code) else 'RESOURCE_COORDINATOR_FAILED'})
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
