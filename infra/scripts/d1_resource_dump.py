"""Validate private SQL in an isolated in-memory SQLite database before upload.

The SQL cannot attach databases, load extensions or change unsafe pragmas. The
source file is unchanged. Acceptance requires full values/schema/sequence and
owner-fence equivalence to the frozen source snapshot supplied by coordinator.
"""
import io
from contextlib import closing
import sqlite3
from d1_resource_verify import inspect_database, assert_identical, SCHEMA
from d1_resource_write_fence import assert_fenced, fingerprint, validate_plan


def authorize(action, first, second, _database, _trigger):
    if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and str(second).lower() in ('load_extension', 'readfile', 'writefile'):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_PRAGMA and str(first).lower() not in ('foreign_keys', 'defer_foreign_keys'):
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def validate_sql_dump(files, file_proof, source_snapshot, fence_plan, assert_owned,
                      source_query=None, assert_source_fenced=None):
    validate_plan(fence_plan)
    if not callable(assert_owned) or files.inspect() != file_proof:
        raise ValueError('RESOURCE_DUMP_FILE_PROOF_REQUIRED')
    assert_owned()
    with closing(sqlite3.connect(':memory:')) as db:
        try:
            db.execute('PRAGMA temp_store=MEMORY')
            db.enable_load_extension(False)
            db.set_authorizer(authorize)
            handle, _before = files.open_sql()
            with handle, io.TextIOWrapper(handle, encoding='utf-8', errors='strict') as text:
                statement = ''
                # This restore and its verification touch only the isolated
                # in-memory database. Recheck remote ownership before accepting
                # the final proof, rather than making one remote round trip per
                # SQL line. Provider mutations retain their own ownership gates.
                for line in text:
                    statement += line
                    if sqlite3.complete_statement(statement):
                        db.execute(statement)
                        statement = ''
                if statement.strip():
                    # Only trailing comments/whitespace may follow a complete
                    # statement. SQLite decides validity without exposing text.
                    db.execute(statement)
            db.set_authorizer(None)
            db.execute('PRAGMA query_only=ON')
        except Exception:
            raise ValueError('RESOURCE_DUMP_RESTORE_FAILED') from None

        def query(_database, sql):
            result = db.execute(sql)
            return [dict(zip([column[0] for column in result.description], row)) for row in result]

        def fenced():
            assert_fenced(query(None, SCHEMA), fence_plan)

        restored = inspect_database(query, None, fenced)
        if source_snapshot == restored or source_query is None or assert_source_fenced is None:
            proof = assert_identical(source_snapshot, restored)
        else:
            from d1_resource_typed import compare_typed
            proof = compare_typed(source_snapshot, restored, lambda sql: query(None, sql),
                                  source_query, assert_source_fenced)
        assert_owned()
        if files.inspect() != file_proof:
            raise ValueError('RESOURCE_DUMP_FILE_CHANGED')
        return {'fileSha256': file_proof['sha256'], 'sourceSnapshotSha256': fingerprint(source_snapshot),
                'restoredSnapshotSha256': fingerprint(restored), 'ownerFenceVerified': True, **proof}
