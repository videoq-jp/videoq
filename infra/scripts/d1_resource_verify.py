"""Read-only exact-value comparison under a coordinator-proven D1 write fence.

Query and fencing are injected. No credential discovery or customer-row output.
SQLite encodes every value before JSON transport, preserving 64-bit integers,
text/blob bytes, NULL/type distinctions and SQLite's round-trip real format.
"""
import hashlib
import json
from d1_resource_write_fence import quote, fingerprint

SCHEMA = 'SELECT type,name,sql FROM sqlite_master ORDER BY type,name'


def inspect_database(query, database, assert_fenced, page_size=32):
    if not callable(query) or not callable(assert_fenced) or type(page_size) is not int or not 1 <= page_size <= 100:
        raise ValueError('RESOURCE_VERIFY_CONTEXT_REQUIRED')
    assert_fenced()
    raw = query(database, SCHEMA)
    schema, tables, sequence = [], [], False
    for row in raw:
        if not isinstance(row, dict) or set(row) != {'type', 'name', 'sql'} or not isinstance(row['name'], str):
            raise ValueError('RESOURCE_VERIFY_SCHEMA_INVALID')
        name = row['name']
        if name == 'sqlite_sequence':
            sequence = True
        if name.startswith(('sqlite_', '_cf_')):
            continue
        if row['type'] not in ('table', 'index', 'view', 'trigger') or not isinstance(row['sql'], str):
            raise ValueError('RESOURCE_VERIFY_SCHEMA_INVALID')
        if row['type'] == 'table':
            tables.append(name)
        schema.append(row)
    if not tables:
        raise ValueError('RESOURCE_VERIFY_APPLICATION_TABLES_REQUIRED')
    if sequence:
        tables.append('sqlite_sequence')
    receipts = []
    for table in sorted(tables):
        assert_fenced()
        columns = query(database, 'PRAGMA table_xinfo(' + quote(table) + ')')
        if not columns or any(not isinstance(c.get('name'), str) for c in columns):
            raise ValueError('RESOURCE_VERIFY_COLUMNS_INVALID')
        names = [c['name'] for c in columns]
        if len(set(names)) != len(names):
            raise ValueError('RESOURCE_VERIFY_COLUMNS_INVALID')
        # Values are encoded by SQLite, never coerced through JS safe integers.
        cells = []
        for name in names:
            column = quote(name)
            cells.append(f"typeof({column}) || ':' || CASE WHEN typeof({column})='real' "
                         f"THEN printf('%!.26g',{column}) ELSE hex(CAST({column} AS BLOB)) END")
        projection = ','.join(expr + ' AS ' + quote('c' + str(i)) for i, expr in enumerate(cells))
        order = ','.join(str(i + 1) + ' COLLATE BINARY' for i in range(len(cells)))
        count_rows = query(database, 'SELECT CAST(count(*) AS TEXT) AS row_count FROM ' + quote(table))
        if (not isinstance(count_rows, list) or len(count_rows) != 1
                or set(count_rows[0]) != {'row_count'} or not isinstance(count_rows[0]['row_count'], str)
                or not count_rows[0]['row_count'].isascii() or not count_rows[0]['row_count'].isdigit()):
            raise ValueError('RESOURCE_VERIFY_COUNT_INVALID')
        expected_rows = int(count_rows[0]['row_count'])
        digest, offset = hashlib.sha256(), 0
        while True:
            assert_fenced()
            rows = query(database, f'SELECT {projection} FROM {quote(table)} ORDER BY {order} LIMIT {page_size} OFFSET {offset}')
            if not isinstance(rows, list) or len(rows) > page_size:
                raise ValueError('RESOURCE_VERIFY_PAGE_INVALID')
            for row in rows:
                if set(row) != {'c' + str(i) for i in range(len(cells))} or any(not isinstance(v, str) for v in row.values()):
                    raise ValueError('RESOURCE_VERIFY_VALUE_INVALID')
                digest.update(json.dumps([row['c' + str(i)] for i in range(len(cells))], ensure_ascii=True, separators=(',', ':')).encode() + b'\n')
            offset += len(rows)
            assert_fenced()
            if len(rows) < page_size:
                break
        if offset != expected_rows:
            raise ValueError('RESOURCE_VERIFY_COUNT_MISMATCH')
        receipts.append({'table': table, 'columnsSha256': fingerprint(columns), 'rows': offset, 'valuesSha256': digest.hexdigest()})
    assert_fenced()
    if query(database, SCHEMA) != raw:
        raise ValueError('RESOURCE_VERIFY_SCHEMA_CHANGED')
    if query(database, 'PRAGMA foreign_key_check'):
        raise ValueError('RESOURCE_VERIFY_FOREIGN_KEYS_INVALID')
    assert_fenced()
    return {'schemaSha256': fingerprint(schema), 'tables': receipts, 'sqliteSequenceIncluded': sequence, 'foreignKeysValid': True}


def assert_identical(source, target):
    if source != target:
        raise ValueError('RESOURCE_DATABASE_VALUES_DIFFER')
    return {'verified': True, 'snapshotSha256': fingerprint(source),
            'tables': len(source['tables']), 'rows': sum(row['rows'] for row in source['tables']),
            'sqliteSequenceIncluded': source['sqliteSequenceIncluded']}
