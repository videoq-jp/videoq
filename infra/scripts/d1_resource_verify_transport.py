"""Read-only fixed-D1 verification transport. No generic SQL or row logging."""
import re
from d1_resource_fence_transport import CloudflareFenceQuery
from d1_resource_fence_control import SOURCE, TARGET, SCHEMA_SQL
from d1_resource_write_fence import validate_plan, quote
from d1_resource_verify import page_sql


class CloudflareVerifyQuery(CloudflareFenceQuery):
    def __init__(self, token, plan, opener=None):
        validate_plan(plan)
        super().__init__(token, opener=opener)
        self.tables = set(plan['original']['tables']) | {'sqlite_sequence'}
        self.columns = {}

    def __call__(self, database, sql):
        if database not in (SOURCE, TARGET) or not isinstance(sql, str):
            raise ValueError('RESOURCE_D1_VERIFY_QUERY_REFUSED')
        if sql in (SCHEMA_SQL, 'PRAGMA foreign_key_check'):
            return self._request(database, sql)
        for table in self.tables:
            if sql == 'PRAGMA table_xinfo(' + quote(table) + ')':
                rows = self._request(database, sql)
                if (not rows or any(not isinstance(row, dict) or not isinstance(row.get('name'), str)
                                    or not row['name'] for row in rows)
                        or len({row['name'] for row in rows}) != len(rows)):
                    raise ValueError('RESOURCE_D1_VERIFY_COLUMNS_INVALID')
                names = [row['name'] for row in rows]
                key = (database, table)
                if key in self.columns and self.columns[key] != names:
                    raise ValueError('RESOURCE_D1_VERIFY_COLUMNS_CHANGED')
                self.columns[key] = names
                return rows
            if sql == 'SELECT CAST(count(*) AS TEXT) AS row_count FROM ' + quote(table):
                return self._request(database, sql)
            match = re.search(r' LIMIT ([1-9][0-9]{0,2}) OFFSET (0|[1-9][0-9]{0,18})$', sql)
            names = self.columns.get((database, table))
            if names and match:
                size, offset = map(int, match.groups())
                if size <= 100 and sql == page_sql(table, names, size, offset):
                    return self._request(database, sql)
        raise ValueError('RESOURCE_D1_VERIFY_QUERY_REFUSED')
