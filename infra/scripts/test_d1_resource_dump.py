from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from d1_resource_dump import validate_sql_dump
from d1_resource_files import PrivateSqlFiles
from d1_resource_verify import inspect_database, SCHEMA
from d1_resource_write_fence import plan_fence, install_statements, assert_fenced


class DumpTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.files = PrivateSqlFiles(str(self.root))
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,value);'
                              'CREATE INDEX values_index ON users(value);'
                              'INSERT INTO users(value) VALUES(9223372036854775807);'
                              'INSERT INTO users(id,value) VALUES(99,NULL); DELETE FROM users WHERE id=99;')
        self.plan = plan_fence(self.query(None, SCHEMA), 'a' * 32)
        for sql in install_statements(self.plan):
            self.db.execute(sql)
        self.snapshot = inspect_database(self.query, None, lambda: assert_fenced(self.query(None, SCHEMA), self.plan))
        self.dump = '\n'.join(self.db.iterdump())
        self.write(self.dump)

    def query(self, _database, sql):
        result = self.db.execute(sql)
        return [dict(zip([c[0] for c in result.description], row)) for row in result]

    def write(self, sql):
        path = self.root / 'source.sql'
        path.write_text(sql)
        path.chmod(0o600)
        self.proof = self.files.inspect()

    def validate(self):
        return validate_sql_dump(self.files, self.proof, self.snapshot, self.plan, lambda: None)

    def test_dump_restores_exact_values_sequence_and_owned_fences_without_changing_file(self):
        proof = self.validate()
        self.assertTrue(proof['verified'])
        self.assertTrue(proof['ownerFenceVerified'])
        self.assertEqual(proof['sourceSnapshotSha256'], proof['restoredSnapshotSha256'])
        self.assertEqual(self.files.inspect(), self.proof)

    def test_local_sql_volume_does_not_multiply_remote_ownership_checks(self):
        self.write(self.dump + '\n' + 'SELECT 1;\n' * 1000)
        calls = 0
        def owned():
            nonlocal calls
            calls += 1
        proof = validate_sql_dump(self.files, self.proof, self.snapshot, self.plan, owned)
        self.assertTrue(proof['verified'])
        self.assertEqual(calls, 2)

    def test_ownership_lost_during_local_restore_cannot_return_a_proof(self):
        owned = True
        original_open = self.files.open_sql
        def check():
            if not owned:
                raise ValueError('RESOURCE_OWNER_LOST')
        def revoke_on_open():
            nonlocal owned
            handle = original_open()
            owned = False
            return handle
        with patch.object(self.files, 'open_sql', side_effect=revoke_on_open):
            with self.assertRaisesRegex(ValueError, 'OWNER_LOST'):
                validate_sql_dump(self.files, self.proof, self.snapshot, self.plan, check)

    def test_sequence_only_loss_and_value_corruption_are_rejected(self):
        for sql in [self.dump.replace("'users',99", "'users',1"), self.dump.replace('9223372036854775807', '9223372036854775806')]:
            self.assertNotEqual(sql, self.dump)
            self.write(sql)
            with self.assertRaisesRegex(ValueError, 'VALUES_DIFFER'):
                self.validate()

    def test_missing_fence_or_index_cannot_pass(self):
        fence = next(iter(self.plan['fenceTriggers']))
        for tail in [f'DROP TRIGGER "{fence}";', 'DROP INDEX values_index;']:
            self.write(self.dump + '\n' + tail)
            with self.assertRaises(ValueError):
                self.validate()

    def test_attach_and_unsafe_pragmas_cannot_write_outside_memory(self):
        outside = self.root / 'not-created.db'
        for sql in [f"ATTACH DATABASE '{outside}' AS outside;", 'PRAGMA writable_schema=ON;', "SELECT load_extension('private-path');"]:
            self.write(sql)
            with self.assertRaisesRegex(ValueError, '^RESOURCE_DUMP_RESTORE_FAILED$'):
                self.validate()
            self.assertFalse(outside.exists())

    def test_changed_private_file_and_lost_ownership_refuse_restore(self):
        (self.root / 'source.sql').write_text(self.dump + '\n-- changed')
        with self.assertRaisesRegex(ValueError, 'FILE_PROOF'):
            self.validate()
        self.write(self.dump)
        def revoked():
            raise ValueError('RESOURCE_OWNER_LOST')
        with self.assertRaisesRegex(ValueError, 'OWNER_LOST'):
            validate_sql_dump(self.files, self.proof, self.snapshot, self.plan, revoked)


if __name__ == '__main__':
    unittest.main()
