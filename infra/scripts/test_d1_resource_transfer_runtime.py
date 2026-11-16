import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from d1_resource_transfer_runtime import prepare_source_snapshot, run_transfer
from d1_resource_fence_control import SOURCE, TARGET, SCHEMA_SQL
from d1_resource_write_fence import plan_fence, install_statements

TOKEN = 'synthetic-runtime-token-0123456789'
URL = 'https://d1.example.r2.cloudflarestorage.com/dump.sql?signature=synthetic'


class Response(io.BytesIO):
    status = 200
    def __init__(self, raw, headers=None):
        super().__init__(raw)
        self.headers = headers or {}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.dbs = {name: sqlite3.connect(':memory:') for name in (SOURCE, TARGET)}
        for db in self.dbs.values():
            self.addCleanup(db.close)
        self.dbs[SOURCE].executescript('CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,value);'
                                      'CREATE INDEX value_index ON users(value);'
                                      'INSERT INTO users(value) VALUES(9223372036854775807);'
                                      'INSERT INTO users(id,value) VALUES(99,NULL);DELETE FROM users WHERE id=99;')
        self.plan = plan_fence(self.sql(SOURCE, SCHEMA_SQL), 'a' * 32)
        for sql in install_statements(self.plan):
            self.dbs[SOURCE].execute(sql)
        self.dbs[SOURCE].commit()
        self.dump = '\n'.join(self.dbs[SOURCE].iterdump()).encode()
        self.uploaded, self.calls, self.ownership_checks, self.lost_start = None, [], 0, False
        outer = self
        class Opener:
            def open(self, request, timeout):
                if request.full_url == URL:
                    outer.calls.append(('file', request.method))
                    if request.method == 'GET':
                        return Response(outer.dump, {'Content-Length': str(len(outer.dump))})
                    outer.uploaded = request.data.read()
                    return Response(b'', {'ETag': '"' + hashlib.md5(outer.uploaded).hexdigest() + '"'})
                database = request.full_url.split('/database/')[1].split('/')[0]
                operation, body = request.full_url.rsplit('/', 1)[1], json.loads(request.data)
                if operation == 'query':
                    result = [{'success': True, 'results': outer.sql(database, body['sql'])}]
                elif operation == 'export':
                    outer.calls.append(('export', body.get('current_bookmark')))
                    if outer.lost_start:
                        raise OSError('response lost')
                    result = {'success': True, 'type': 'export', 'at_bookmark': 'export-1'}
                    if body.get('current_bookmark'):
                        result.update(status='complete', result={'signed_url': URL})
                else:
                    outer.calls.append(('import', body['action']))
                    result = {'success': True, 'type': 'import'}
                    if body['action'] == 'init':
                        result.update(filename='target-hash.sql', upload_url=URL)
                    else:
                        result['at_bookmark'] = 'import-1'
                        if body['action'] == 'ingest':
                            outer.dbs[TARGET].executescript(outer.uploaded.decode())
                        else:
                            result['status'] = 'complete'
                return Response(json.dumps({'success': True, 'result': result}).encode())
        self.opener = Opener()
        snapshot = prepare_source_snapshot(TOKEN, self.plan, self.owned, self.opener)
        self.config = {'directory': str(Path(self.directory.name)), 'run': 'a' * 32, 'source': 'b' * 40,
                       'planSha256': 'c' * 64, 'fencePlan': self.plan, 'sourceSnapshot': snapshot}

    def sql(self, database, sql):
        result = self.dbs[database].execute(sql)
        return [dict(zip([column[0] for column in result.description], row)) for row in result]

    def owned(self):
        self.ownership_checks += 1

    def next(self, status=False):
        return run_transfer(TOKEN, self.config, self.owned, lambda *_args: self.owned(), status, self.opener)

    def until(self, phase):
        for _ in range(20):
            result = self.next()
            if result['phase'] == phase:
                return result
        self.fail('phase not reached')

    def test_real_files_journal_lock_dump_restore_and_db_comparison_complete(self):
        self.assertFalse(self.next(status=True)['databaseVerified'])
        self.assertTrue(self.until('database-verified')['databaseVerified'])
        proof = self.next(status=True)
        self.assertTrue(proof['databaseVerified'])
        self.assertEqual(len(proof['receiptSha256']), 64)
        self.assertEqual(self.uploaded, self.dump)
        self.assertGreater(self.ownership_checks, 20)
        self.assertEqual(sum(call == ('import', 'ingest') for call in self.calls), 1)
        self.assertEqual(self.sql(TARGET, 'SELECT seq FROM sqlite_sequence'), [{'seq': 99}])
        with self.assertRaises(sqlite3.IntegrityError):
            self.dbs[TARGET].execute('UPDATE users SET value=1')

    def test_populated_target_is_not_overwritten_or_merged(self):
        self.until('dump-verified')
        self.dbs[TARGET].execute('CREATE TABLE unrelated(id INTEGER)')
        with self.assertRaisesRegex(ValueError, 'TARGET_NOT_EMPTY'):
            self.next()
        self.assertFalse(any(call == ('import', 'init') for call in self.calls))

    def test_uncertain_export_start_retains_intent_and_never_restarts(self):
        self.lost_start = True
        with self.assertRaisesRegex(ValueError, 'REQUEST_UNCERTAIN'):
            self.next()
        self.assertTrue(self.next(status=True)['reconciliationRequired'])
        with self.assertRaisesRegex(ValueError, 'START_RECONCILIATION'):
            self.next()
        self.assertEqual(sum(call[0] == 'export' for call in self.calls), 1)


if __name__ == '__main__':
    unittest.main()
