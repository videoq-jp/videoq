import sqlite3
import unittest
from d1_resource_verify import inspect_database, assert_identical


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.dbs = {key: sqlite3.connect(':memory:') for key in ('source', 'target')}
        self.owned = True
        for db in self.dbs.values():
            self.addCleanup(db.close)
            db.executescript('CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,value);'
                             'CREATE INDEX value_index ON users(value);'
                             'CREATE VIEW visible AS SELECT * FROM users;'
                             'CREATE TABLE child(user_id INTEGER REFERENCES users(id));')
            for value in [None, 9223372036854775807, -9223372036854775808, 0.1, 'a\x00é', b'\x00\xff', 'same', 'same']:
                db.execute('INSERT INTO users(value) VALUES(?)', (value,))
            db.execute('INSERT INTO users(id,value) VALUES(100,0)')
            db.execute('DELETE FROM users WHERE id=100')
            db.commit()

    def query(self, database, sql):
        result = self.dbs[database].execute(sql)
        return [dict(zip([c[0] for c in result.description], row)) for row in result]

    def fence(self):
        if not self.owned:
            raise ValueError('RESOURCE_FENCE_REQUIRED')

    def snapshot(self, database):
        return inspect_database(self.query, database, self.fence, page_size=2)

    def test_exact_rows_types_blob_null_duplicates_and_sequence_are_compared(self):
        proof = assert_identical(self.snapshot('source'), self.snapshot('target'))
        self.assertTrue(proof['verified'])
        self.assertTrue(proof['sqliteSequenceIncluded'])
        self.assertEqual(proof['rows'], 9)
        self.assertNotIn('9223372036854775807', str(proof))

    def test_changed_highwater_with_identical_visible_rows_is_detected(self):
        self.dbs['target'].execute('UPDATE sqlite_sequence SET seq=99')
        with self.assertRaisesRegex(ValueError, 'VALUES_DIFFER'):
            assert_identical(self.snapshot('source'), self.snapshot('target'))

    def test_int64_one_unit_difference_type_and_blob_changes_are_detected(self):
        baseline = self.snapshot('source')
        for value in [9223372036854775806, '9223372036854775807', b'\xff']:
            self.dbs['target'].execute('UPDATE users SET value=? WHERE id=2', (value,))
            with self.assertRaisesRegex(ValueError, 'VALUES_DIFFER'):
                assert_identical(baseline, self.snapshot('target'))

    def test_index_and_view_changes_cannot_pass_row_only_comparison(self):
        baseline = self.snapshot('source')
        self.dbs['target'].execute('DROP INDEX value_index')
        with self.assertRaisesRegex(ValueError, 'VALUES_DIFFER'):
            assert_identical(baseline, self.snapshot('target'))

    def test_foreign_key_violation_and_lost_fence_refuse_receipt(self):
        self.dbs['target'].execute('INSERT INTO child VALUES(999)')
        with self.assertRaisesRegex(ValueError, 'FOREIGN_KEYS'):
            self.snapshot('target')
        self.owned = False
        with self.assertRaisesRegex(ValueError, 'FENCE_REQUIRED'):
            self.snapshot('source')

    def test_physical_row_order_and_duplicate_rows_do_not_affect_digest(self):
        for name, values in [('source', ['z', 'a', 'a', 'b']), ('target', ['b', 'a', 'z', 'a'])]:
            self.dbs[name].execute('CREATE TABLE bag(value TEXT)')
            self.dbs[name].executemany('INSERT INTO bag VALUES(?)', [(value,) for value in values])
        self.assertTrue(assert_identical(self.snapshot('source'), self.snapshot('target'))['verified'])

    def test_short_provider_page_cannot_silently_omit_rows(self):
        def query(database, sql):
            return [] if sql.startswith('SELECT typeof(') and 'FROM "users"' in sql else self.query(database, sql)
        with self.assertRaisesRegex(ValueError, 'COUNT_MISMATCH'):
            inspect_database(query, 'source', self.fence)

    def test_provider_truncation_or_unencoded_value_is_rejected(self):
        for malformed in [[{'c0': 1}], [{}]]:
            def query(database, sql):
                return malformed if sql.startswith('SELECT typeof(') else self.query(database, sql)
            with self.assertRaisesRegex(ValueError, 'VALUE_INVALID'):
                inspect_database(query, 'source', self.fence)


if __name__ == '__main__':
    unittest.main()
