import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from update_transaction import UpdateTransaction


class UpdateTransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'update.json'
        self.actions = Mock()
        self.actions.snapshot.return_value = {'source_sha': 'old', 'replicas': 1}
        self.actions.busy.return_value = False
        self.actions.backup.return_value = '/private/backup'
        self.tx = UpdateTransaction(self.path, self.actions)

    def test_busy_work_defers_without_backup_or_migration(self):
        self.actions.busy.return_value = True
        self.assertEqual(self.tx.start({'source_sha': 'new'}), 'deferred')
        self.actions.backup.assert_not_called()
        self.actions.apply.assert_not_called()
        self.actions.resume.assert_called_once()
        self.assertFalse(self.path.exists())

    def test_failed_target_health_restores_data_before_old_traffic(self):
        self.actions.health.side_effect = [RuntimeError('target GPU failed'), None]
        with self.assertRaisesRegex(RuntimeError, 'target GPU'):
            self.tx.start({'source_sha': 'new'})
        calls = [c[0] for c in self.actions.mock_calls]
        self.assertLess(calls.index('verify_backup'), calls.index('apply'))
        self.assertLess(calls.index('rollback'), calls.index('resume'))
        self.actions.commit.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_failed_rollback_remains_recoverable_and_closed(self):
        self.actions.apply.side_effect = RuntimeError('migration failed')
        self.actions.rollback.side_effect = RuntimeError('disk unavailable')
        with self.assertRaisesRegex(RuntimeError, 'disk unavailable'):
            self.tx.start({'source_sha': 'new'})
        self.assertEqual(json.loads(self.path.read_text())['phase'], 'rolling_back')
        self.actions.resume.assert_not_called()
        self.actions.rollback.side_effect = None
        self.assertTrue(self.tx.recover())
        self.assertFalse(self.path.exists())

    def test_every_persisted_phase_can_recover_after_power_loss(self):
        for phase in ('freezing', 'backing_up', 'applying', 'committing', 'rolling_back'):
            with self.subTest(phase=phase):
                self.actions.reset_mock()
                self.path.write_text(json.dumps({'version': 1, 'phase': phase,
                    'previous': {'source_sha': 'old'}, 'backup': '/private/backup'}))
                self.tx.recover()
                if phase in ('applying', 'committing', 'rolling_back'):
                    self.actions.rollback.assert_called_once()
                    self.actions.health.assert_called_once_with(previous=True)
                else:
                    self.actions.rollback.assert_not_called()
                self.actions.resume.assert_called_once()
                self.assertFalse(self.path.exists())

    def test_resume_failure_after_commit_preserves_any_newly_accepted_writes(self):
        self.actions.resume.side_effect = [RuntimeError('gateway failed'), None]
        with self.assertRaisesRegex(RuntimeError, 'gateway failed'):
            self.tx.start({'source_sha': 'new'})
        self.actions.rollback.assert_not_called()
        self.assertEqual(json.loads(self.path.read_text())['phase'], 'committed')
        self.assertTrue(self.tx.recover())
        self.actions.rollback.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_unhealthy_committed_release_is_never_replaced_by_an_old_snapshot(self):
        self.path.write_text(json.dumps({'version': 1, 'phase': 'committed',
            'previous': {'source_sha': 'old'}, 'backup': '/private/backup'}))
        self.actions.health.side_effect = RuntimeError('target unavailable')
        with self.assertRaisesRegex(RuntimeError, 'target unavailable'):
            self.tx.recover()
        self.actions.rollback.assert_not_called()
        self.actions.resume.assert_not_called()
        self.assertTrue(self.path.exists())

    def test_unknown_journal_never_runs_cluster_actions(self):
        self.path.write_text('{"version":2,"phase":"applying"}')
        with self.assertRaises(ValueError):
            self.tx.recover()
        self.assertEqual(self.actions.mock_calls, [])

    def test_success_promotes_only_after_target_health(self):
        self.assertEqual(self.tx.start({'source_sha': 'new'}), 'updated')
        calls = [c[0] for c in self.actions.mock_calls]
        self.assertLess(calls.index('freeze'), calls.index('busy'))
        self.assertLess(calls.index('health'), calls.index('commit'))
        self.assertLess(calls.index('commit'), calls.index('resume'))
        self.actions.rollback.assert_not_called()
        self.assertFalse(self.path.exists())


if __name__ == '__main__':
    unittest.main()
