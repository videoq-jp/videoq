"""Crash-recoverable update transaction; transport and Kubernetes actions are injected.

The adapter must verify a candidate before calling start(), freeze ingress and cron
writers before busy(), and restore the cold data snapshot together with the old
release in rollback(). Reverting only a Helm revision is insufficient after a DB
migration. A failed rollback deliberately leaves the durable journal in place.
"""
import json
import os
from pathlib import Path
from common import private_json


class UpdateTransaction:
    def __init__(self, journal, adapter):
        self.journal = Path(journal)
        self.adapter = adapter

    def save(self, record, phase):
        record['phase'] = phase
        private_json(self.journal, record)
        with self.journal.open('rb') as stream:
            os.fsync(stream.fileno())
        self.sync_directory()

    def sync_directory(self):
        descriptor = os.open(self.journal.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def clear(self):
        self.journal.unlink()
        self.sync_directory()

    def recover(self):
        if not self.journal.exists():
            return False
        record = json.loads(self.journal.read_text())
        if record.get('version') != 1 or record.get('phase') not in (
                'freezing', 'backing_up', 'applying', 'committing', 'rolling_back', 'committed'):
            raise ValueError('Unknown update journal; manual recovery is required')
        if record['phase'] == 'committed':
            # Traffic may already have accepted new writes. Never restore the
            # pre-update database once the durable promotion point is crossed.
            self.adapter.health(previous=False)
            self.adapter.resume(record, previous=False)
            self.clear()
        else:
            self.restore(record)
        return True

    def restore(self, record):
        phase = record['phase']
        if phase in ('applying', 'committing', 'rolling_back'):
            # Persist intent first: an interrupted restore must be retried, never
            # mistaken for a completed update or an untouched database.
            self.save(record, 'rolling_back')
            self.adapter.rollback(record)
            self.adapter.health(previous=True)
        self.adapter.resume(record, previous=True)
        self.clear()

    def start(self, candidate):
        if self.journal.exists():
            raise ValueError('Recover the interrupted update before selecting another release')
        # snapshot() is read-only, and must include old release/state and replica
        # counts. Never discover the old runtime after applying the candidate.
        record = {'version': 1, 'candidate': candidate,
                  'previous': self.adapter.snapshot()}
        self.save(record, 'freezing')
        try:
            self.adapter.freeze(record)
            # A second check after ingress/cron freeze closes the check/use race.
            # The adapter must treat unavailable DB/queue observations as errors.
            if self.adapter.busy():
                self.adapter.resume(record, previous=True)
                self.clear()
                return 'deferred'
            self.save(record, 'backing_up')
            record['backup'] = self.adapter.backup(record)
            self.adapter.verify_backup(record['backup'])
            self.save(record, 'applying')
            self.adapter.apply(record)
            self.adapter.health(previous=False)
            self.save(record, 'committing')
            self.adapter.commit(record)
            self.save(record, 'committed')
            self.adapter.resume(record, previous=False)
        except BaseException:
            # Includes SIGINT/KeyboardInterrupt. SIGKILL/power loss instead leaves
            # the journal for recover() on the next timer activation.
            if record['phase'] == 'committed':
                # resume() may have opened some ingress before failing. Retain
                # target data and retry forward recovery instead of losing it.
                self.adapter.freeze(record)
            else:
                self.restore(record)
            raise
        self.clear()
        return 'updated'
