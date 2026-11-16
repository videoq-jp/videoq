"""Append-only private transfer records; no provider calls or automatic recovery.

Each record is exclusive, fsynced and hash chained under the pinned run/source/
plan context. Missing/partial/corrupt records stop recovery. This is local working
state, not independent disaster recovery or a substitute for the AWS hold.
"""
import json
import os
from pathlib import Path
import re
import stat
from d1_resource_write_fence import fingerprint

PHASES = ('export-intent', 'export-handle', 'export-complete', 'downloaded', 'dump-verified',
          'import-initialized', 'uploaded', 'ingest-intent', 'import-handle', 'import-complete', 'database-verified')
LIMIT = 1024 * 1024


class TransferJournal:
    def __init__(self, directory, run, source, plan_sha256, phases=PHASES):
        if (not isinstance(run, str) or re.fullmatch('[a-f0-9]{32}', run) is None
                or not isinstance(source, str) or re.fullmatch('[a-f0-9]{40}', source) is None
                or not isinstance(plan_sha256, str) or re.fullmatch('[a-f0-9]{64}', plan_sha256) is None):
            raise ValueError('RESOURCE_TRANSFER_JOURNAL_CONTEXT_REQUIRED')
        if phases not in (PHASES, ('intent','accepted','verified')):
            raise ValueError('RESOURCE_TRANSFER_JOURNAL_PHASES_REQUIRED')
        self.phases = phases
        root = Path(directory)
        if not root.is_absolute():
            raise ValueError('RESOURCE_TRANSFER_JOURNAL_DIRECTORY_REQUIRED')
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
            raise ValueError('RESOURCE_TRANSFER_JOURNAL_DIRECTORY_REQUIRED')
        self.root, self.identity = root.resolve(), (info.st_dev, info.st_ino)
        self.context = {'run': run, 'source': source, 'planSha256': plan_sha256}

    def checked(self):
        info = self.root.lstat()
        if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700
                or info.st_uid != os.getuid() or (info.st_dev, info.st_ino) != self.identity):
            raise ValueError('RESOURCE_TRANSFER_JOURNAL_DIRECTORY_CHANGED')

    def filename(self, index):
        return f'{index:02d}-{self.phases[index]}.json'

    def read(self):
        self.checked()
        names = sorted(path.name for path in self.root.iterdir())
        if len(names) > len(self.phases) or names != [self.filename(i) for i in range(len(names))]:
            raise ValueError('RESOURCE_TRANSFER_JOURNAL_GAP')
        records, previous = [], None
        for i, name in enumerate(names):
            fd = os.open(self.root / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as handle:
                before = os.fstat(handle.fileno())
                if (not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != 0o600
                        or before.st_uid != os.getuid() or before.st_size > LIMIT):
                    raise ValueError('RESOURCE_TRANSFER_JOURNAL_UNSAFE')
                raw = handle.read(LIMIT + 1)
                after = os.fstat(handle.fileno())
                if (len(raw) != before.st_size or len(raw) > LIMIT
                        or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
                    raise ValueError('RESOURCE_TRANSFER_JOURNAL_CHANGED')
            try:
                record = json.loads(raw)
                body = {key: record[key] for key in ('version', 'context', 'phase', 'previousSha256', 'value')}
                if (set(record) != set(body) | {'sha256'} or body['version'] != 1
                        or body['context'] != self.context or body['phase'] != self.phases[i]
                        or body['previousSha256'] != previous or not isinstance(body['value'], dict)
                        or record['sha256'] != fingerprint(body)):
                    raise ValueError('INVALID_RECORD')
            except Exception:
                raise ValueError('RESOURCE_TRANSFER_JOURNAL_CORRUPT') from None
            records.append(record)
            previous = record['sha256']
        self.checked()
        return records

    def save(self, phase, value):
        if phase not in self.phases or not isinstance(value, dict):
            raise ValueError('RESOURCE_TRANSFER_JOURNAL_VALUE_REQUIRED')
        records, index = self.read(), self.phases.index(phase)
        if index < len(records):
            if records[index]['value'] != value:
                raise ValueError('RESOURCE_TRANSFER_JOURNAL_PROOF_CHANGED')
            return records[index]
        if index != len(records):
            raise ValueError('RESOURCE_TRANSFER_JOURNAL_ORDER_REQUIRED')
        body = {'version': 1, 'context': self.context, 'phase': phase,
                'previousSha256': records[-1]['sha256'] if records else None, 'value': value}
        record = {**body, 'sha256': fingerprint(body)}
        raw = json.dumps(record, separators=(',', ':'), allow_nan=False).encode()
        if len(raw) > LIMIT:
            raise ValueError('RESOURCE_TRANSFER_JOURNAL_LIMIT')
        self.checked()
        fd = os.open(self.root / self.filename(index), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        directory = os.open(self.root, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        found = self.read()
        if len(found) != index + 1 or found[index] != record:
            raise ValueError('RESOURCE_TRANSFER_JOURNAL_NOT_DURABLE')
        return record
