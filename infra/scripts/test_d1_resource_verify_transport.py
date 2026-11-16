import io
import json
import sqlite3
import unittest
from d1_resource_fence_control import SOURCE, TARGET, SCHEMA_SQL
from d1_resource_verify_transport import CloudflareVerifyQuery
from d1_resource_verify import inspect_database, assert_identical, page_sql
from d1_resource_write_fence import plan_fence


class Response(io.BytesIO):
    status = 200


class VerifyTransportTests(unittest.TestCase):
    def setUp(self):
        self.dbs = {key: sqlite3.connect(':memory:') for key in (SOURCE, TARGET)}
        self.calls = []
        for db in self.dbs.values():
            self.addCleanup(db.close)
            db.executescript('CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,value);'
                             'INSERT INTO users(value) VALUES(9223372036854775807);')
        self.plan = plan_fence(self.sql(SOURCE, SCHEMA_SQL), 'a' * 32)
        outer = self
        class Opener:
            def open(self, request, timeout):
                sql = json.loads(request.data)['sql']
                database = request.full_url.split('/database/')[1].split('/')[0]
                outer.calls.append(sql)
                return Response(json.dumps({'success': True, 'result': [{'success': True, 'results': outer.sql(database, sql)}]}).encode())
        self.query = CloudflareVerifyQuery('synthetic-token-0123456789', self.plan, Opener())

    def sql(self, database, sql):
        result = self.dbs[database].execute(sql)
        return [dict(zip([c[0] for c in result.description], row)) for row in result]

    def test_full_verifier_uses_only_authorized_reads_and_preserves_int64_difference(self):
        # HTTP-shaped fixture transport, SQLite storage, explicit mock fence.
        baseline = inspect_database(self.query, SOURCE, lambda: None)
        self.assertTrue(assert_identical(baseline, inspect_database(self.query, TARGET, lambda: None))['verified'])
        self.dbs[TARGET].execute('UPDATE users SET value=9223372036854775806')
        with self.assertRaisesRegex(ValueError, 'VALUES_DIFFER'):
            assert_identical(baseline, inspect_database(self.query, TARGET, lambda: None))

    def test_arbitrary_sql_other_databases_and_appended_statements_never_reach_http(self):
        for database, sql in [(SOURCE, 'DELETE FROM users'), (SOURCE, 'SELECT * FROM users'),
                              ('other', SCHEMA_SQL), (SOURCE, SCHEMA_SQL + '; DROP TABLE users'),
                              (SOURCE, 'PRAGMA writable_schema=ON')]:
            with self.assertRaisesRegex(ValueError, 'REFUSED'):
                self.query(database, sql)
        self.assertEqual(self.calls, [])

    def test_page_requires_observed_columns_and_exact_bounded_sql(self):
        page = page_sql('users', ['id', 'value'], 2, 0)
        with self.assertRaisesRegex(ValueError, 'REFUSED'):
            self.query(SOURCE, page)
        self.query(SOURCE, 'PRAGMA table_xinfo("users")')
        self.assertEqual(len(self.query(SOURCE, page)), 1)
        for sql in [page + '; SELECT 1', page.replace('LIMIT 2', 'LIMIT 101'), page.replace('OFFSET 0', 'OFFSET -1')]:
            with self.assertRaisesRegex(ValueError, 'REFUSED'):
                self.query(SOURCE, sql)

    def test_column_identity_drift_refuses_a_new_read_plan(self):
        self.query(SOURCE, 'PRAGMA table_xinfo("users")')
        self.dbs[SOURCE].execute('ALTER TABLE users ADD COLUMN late TEXT')
        with self.assertRaisesRegex(ValueError, 'COLUMNS_CHANGED'):
            self.query(SOURCE, 'PRAGMA table_xinfo("users")')

    def test_unknown_tables_and_cross_database_column_cache_are_refused(self):
        self.query(SOURCE, 'PRAGMA table_xinfo("users")')
        with self.assertRaisesRegex(ValueError, 'REFUSED'):
            self.query(TARGET, page_sql('users', ['id', 'value'], 2, 0))
        with self.assertRaisesRegex(ValueError, 'REFUSED'):
            self.query(SOURCE, 'PRAGMA table_xinfo("other")')


if __name__ == '__main__':
    unittest.main()
