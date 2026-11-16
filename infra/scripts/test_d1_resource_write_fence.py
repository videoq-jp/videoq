import copy
import sqlite3
import unittest
from d1_resource_write_fence import plan_fence, install_statements, assert_fenced, removal_statements

OWNER = 'a' * 32


class FenceTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE users(id INTEGER PRIMARY KEY, value INTEGER);
CREATE TABLE audit(value INTEGER);
CREATE TRIGGER audit_user AFTER UPDATE ON users BEGIN INSERT INTO audit VALUES(new.value); END;
INSERT INTO users VALUES(1, 1);''')
        self.db.commit()

    def schema(self):
        return [dict(zip(('type','name','sql'), row)) for row in self.db.execute('SELECT type,name,sql FROM sqlite_master')]

    def test_all_application_tables_block_writes_and_preserve_original_triggers(self):
        self.db.execute('INSERT INTO audit VALUES(0)')
        plan = plan_fence(self.schema(), OWNER)
        for sql in install_statements(plan):
            self.db.execute(sql)
        self.assertEqual(assert_fenced(self.schema(), plan)['fenceTriggers'], 6)
        for sql in ['INSERT INTO users VALUES(2, 2)', 'UPDATE users SET value=2', 'DELETE FROM users',
                    'INSERT INTO audit VALUES(2)', 'UPDATE audit SET value=2', 'DELETE FROM audit']:
            with self.subTest(sql=sql), self.assertRaisesRegex(sqlite3.IntegrityError, 'RESOURCE_REPLACEMENT_FENCED'):
                self.db.execute(sql)
        self.assertEqual(self.db.execute('SELECT * FROM users').fetchall(), [(1, 1)])
        self.assertEqual(self.db.execute('SELECT * FROM audit').fetchall(), [(0,)])
        for sql in removal_statements(self.schema(), plan):
            self.db.execute(sql)
        self.db.execute('UPDATE users SET value=3')
        self.assertEqual(self.db.execute('SELECT * FROM audit').fetchall(), [(0,), (3,)])

    def test_incomplete_fence_or_changed_schema_refuses_removal(self):
        plan = plan_fence(self.schema(), OWNER)
        for sql in install_statements(plan)[:-1]:
            self.db.execute(sql)
        with self.assertRaises(ValueError):
            removal_statements(self.schema(), plan)
        self.db.execute(install_statements(plan)[-1])
        self.db.execute('CREATE TABLE late_writer(id INTEGER)')
        with self.assertRaises(ValueError):
            assert_fenced(self.schema(), plan)

    def test_forged_plan_and_conflicting_owner_are_rejected(self):
        plan = plan_fence(self.schema(), OWNER)
        forged = copy.deepcopy(plan)
        forged['fenceTriggers'].pop(next(iter(forged['fenceTriggers'])))
        with self.assertRaises(ValueError):
            install_statements(forged)
        for sql in install_statements(plan):
            self.db.execute(sql)
        with self.assertRaises(ValueError):
            plan_fence(self.schema(), 'b' * 32)

    def test_table_identifiers_are_quoted_and_virtual_tables_refused(self):
        self.db.execute('CREATE TABLE "table""with quote"(id INTEGER)')
        plan = plan_fence(self.schema(), OWNER)
        for sql in install_statements(plan):
            self.db.execute(sql)
        assert_fenced(self.schema(), plan)
        rows = [{'type':'table','name':'search','sql':'CREATE VIRTUAL TABLE search USING fts5(content)'}]
        with self.assertRaises(ValueError):
            plan_fence(rows, OWNER)


if __name__ == '__main__':
    unittest.main()
