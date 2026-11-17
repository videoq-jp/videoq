import sqlite3
import unittest
from d1_resource_fence_control import FenceControl, SOURCE, TARGET
from d1_resource_write_fence import quote


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.dbs = {key: sqlite3.connect(':memory:') for key in (SOURCE, TARGET)}
        for db in self.dbs.values():
            self.addCleanup(db.close)
            db.executescript('CREATE TABLE users(id INTEGER PRIMARY KEY,value INTEGER);'
                             'CREATE TABLE audit(value INTEGER);'
                             'CREATE TRIGGER original AFTER UPDATE ON users BEGIN INSERT INTO audit VALUES(new.value); END;'
                             'INSERT INTO users VALUES(1,1); INSERT INTO audit VALUES(0);')
        self.writes, self.lost, self.owned, self.safe = [], False, True, True
        self.control = FenceControl(self.query, self.ownership, self.target_safe)
        self.plan = self.control.prepare('a' * 32)

    def query(self, target, sql):
        if not sql.startswith('SELECT'):
            self.writes.append((target, sql))
        result = self.dbs[target].execute(sql)
        rows = [dict(zip([c[0] for c in result.description], row)) for row in result] if result.description else []
        self.dbs[target].commit()
        if self.lost and not sql.startswith('SELECT'):
            self.lost = False
            raise RuntimeError('lost response')
        return rows

    def ownership(self):
        if not self.owned:
            raise ValueError('RESOURCE_OWNERSHIP_LOST')

    def target_safe(self, _plan):
        if not self.safe:
            raise ValueError('RESOURCE_TARGET_NOT_VERIFIED')

    def copy_fences(self):
        for sql in self.plan['fenceTriggers'].values():
            self.dbs[TARGET].execute(sql)
        self.dbs[TARGET].commit()

    def test_source_fence_blocks_all_writes_and_target_removal_preserves_original(self):
        self.control.fence_source(self.plan)
        for sql in ['INSERT INTO users VALUES(2,2)', 'UPDATE users SET value=2', 'DELETE FROM users',
                    'INSERT INTO audit VALUES(2)', 'UPDATE audit SET value=2', 'DELETE FROM audit']:
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'FENCED'):
                self.dbs[SOURCE].execute(sql)
        self.copy_fences()
        self.control.unfence_target(self.plan)
        self.query(TARGET, 'UPDATE users SET value=3')
        self.assertEqual(self.query(TARGET, 'SELECT * FROM audit'), [{'value': 0}, {'value': 3}])
        with self.assertRaises(sqlite3.IntegrityError):
            self.dbs[SOURCE].execute('UPDATE users SET value=4')

    def test_partial_lost_response_reconciles_without_recreating_owned_triggers(self):
        self.lost = True
        with self.assertRaises(RuntimeError):
            self.control.fence_source(self.plan)
        self.assertEqual(len(self.control.observe(self.plan)['installed']), 1)
        self.control.fence_source(self.plan)
        self.control.fence_source(self.plan)
        self.assertEqual(len(self.writes), 6)
        self.copy_fences()
        self.lost = True
        with self.assertRaises(RuntimeError):
            self.control.unfence_target(self.plan)
        self.control.unfence_target(self.plan)
        self.control.unfence_target(self.plan)
        self.assertEqual(len(self.writes), 12)

    def test_unknown_trigger_definition_or_new_table_refuses_further_mutation(self):
        self.control.fence_source(self.plan)
        name = next(iter(self.plan['fenceTriggers']))
        self.dbs[SOURCE].execute('DROP TRIGGER ' + quote(name))
        self.dbs[SOURCE].execute('CREATE TRIGGER ' + quote(name) + ' BEFORE INSERT ON users BEGIN SELECT 1; END')
        before = len(self.writes)
        with self.assertRaisesRegex(ValueError, 'TRIGGER_CHANGED'):
            self.control.fence_source(self.plan)
        self.assertEqual(len(self.writes), before)
        self.dbs[TARGET].execute('CREATE TABLE late(id INTEGER)')
        with self.assertRaisesRegex(ValueError, 'SCHEMA_CHANGED'):
            self.control.unfence_target(self.plan)

    def test_ownership_and_verified_target_proof_are_mandatory(self):
        self.owned = False
        with self.assertRaisesRegex(ValueError, 'OWNERSHIP'):
            self.control.fence_source(self.plan)
        self.owned = True
        self.copy_fences()
        self.safe = False
        with self.assertRaisesRegex(ValueError, 'NOT_VERIFIED'):
            self.control.unfence_target(self.plan)
        self.assertEqual(self.writes, [])
        with self.assertRaises(ValueError):
            FenceControl(self.query, self.ownership, None)

    def test_missing_original_trigger_is_not_repaired_or_removed(self):
        self.dbs[SOURCE].execute('DROP TRIGGER original')
        with self.assertRaisesRegex(ValueError, 'ORIGINAL_TRIGGER_MISSING'):
            self.control.fence_source(self.plan)
        self.assertEqual(self.writes, [])

    def test_source_abort_unfence_is_default_denied_and_preserves_original_triggers(self):
        self.control.fence_source(self.plan)
        with self.assertRaisesRegex(ValueError, 'ABORT_SAFETY'):
            self.control.unfence_source(self.plan)
        recovery = FenceControl(self.query, self.ownership, self.target_safe, self.target_safe)
        self.safe = False
        with self.assertRaisesRegex(ValueError, 'NOT_VERIFIED'):
            recovery.unfence_source(self.plan)
        self.safe = True
        self.lost = True
        with self.assertRaises(RuntimeError):
            recovery.unfence_source(self.plan)
        self.assertEqual(len(recovery.observe(self.plan)['installed']), 5)
        recovery.unfence_source(self.plan)
        recovery.unfence_source(self.plan)
        self.query(SOURCE, 'UPDATE users SET value=7')
        self.assertEqual(self.query(SOURCE, 'SELECT * FROM audit'), [{'value': 0}, {'value': 7}])
        self.assertEqual(len([row for row in self.writes if row[1].startswith('DROP TRIGGER')]), 6)

    def test_source_abort_safety_is_rechecked_before_each_removal(self):
        self.control.fence_source(self.plan)
        checks = 0
        def safe(_plan):
            nonlocal checks
            checks += 1
            if checks >= 3:
                raise ValueError('RESOURCE_ABORT_SAFETY_LOST')
        recovery = FenceControl(self.query, self.ownership, self.target_safe, safe)
        with self.assertRaisesRegex(ValueError, 'SAFETY_LOST'):
            recovery.unfence_source(self.plan)
        self.assertEqual(len(recovery.observe(self.plan)['installed']), 5)


if __name__ == '__main__':
    unittest.main()
