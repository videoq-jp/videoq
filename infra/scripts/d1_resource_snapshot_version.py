"""Reuse a full exact snapshot only for the same freshly observed D1 state.

Time Travel bookmarks identify a specific database state. Every reuse checks
ownership/fencing and reads that provider bookmark again before and after it.
Changed versions run the original full verifier; no sampled comparison is used.
"""
import json
import os
import stat
from d1_resource_write_fence import fingerprint
from d1_resource_verify import inspect_database


def inspect_versioned(query, database, fenced, files, context):
    files.checked();fenced()
    before = query.bookmark(database)
    fenced()
    path = files.root / ('verified-version-' + database + '.json')
    bound = {**context, 'database': database}
    if path.exists():
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_uid != os.getuid() or info.st_size > 1024 * 1024):
                raise ValueError('RESOURCE_VERSION_PROOF_UNSAFE')
            value = json.loads(handle.read(1024 * 1024 + 1))
        if (value.get('context') != bound
                or value.get('snapshotSha256') != fingerprint(value.get('snapshot'))):
            raise ValueError('RESOURCE_VERSION_PROOF_INVALID')
        if value.get('bookmark') == before:
            fenced();after = query.bookmark(database);fenced();files.checked()
            if after == before:
                return value['snapshot']
    snapshot = inspect_database(query, database, fenced)
    fenced();after = query.bookmark(database);fenced();files.checked()
    if before == after:
        value = {'context': bound, 'bookmark': after, 'snapshot': snapshot,
                 'snapshotSha256': fingerprint(snapshot)}
        temporary = files.root / (path.name + '.new')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle);handle.flush();os.fsync(handle.fileno())
        os.replace(temporary, path)
        files.sync_directory()
    return snapshot
