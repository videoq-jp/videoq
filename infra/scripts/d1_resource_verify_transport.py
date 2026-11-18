"""Read-only fixed-D1 verification transport. No generic SQL or row logging."""
import re
import json
import urllib.request
from d1_resource_fence_transport import CloudflareFenceQuery, ACCOUNT
from d1_resource_fence_control import SOURCE, TARGET, SCHEMA_SQL
from d1_resource_write_fence import validate_plan, quote
from d1_resource_verify import page_sql


LIMIT = 8 * 1024 * 1024


class ResponseTooLarge(ValueError):
    pass


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

    def bookmark(self, database):
        if database not in (SOURCE, TARGET):
            raise ValueError('RESOURCE_D1_VERIFY_QUERY_REFUSED')
        request = urllib.request.Request(
            f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{database}/time_travel/bookmark',
            method='GET', headers={'Authorization': 'Bearer ' + self.token})
        try:
            with self.opener.open(request, timeout=30) as response:
                if response.status != 200:
                    raise ValueError('RESOURCE_VERSION_BOOKMARK_FAILED')
                raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError('RESOURCE_VERSION_BOOKMARK_LIMIT')
            result = json.loads(raw)
            bookmark = result.get('result', {}).get('bookmark')
            if (result.get('success') is not True or result.get('errors') not in (None, [])
                    or not isinstance(bookmark, str) or not 1 <= len(bookmark) <= 512
                    or any(ord(char) < 33 or ord(char) > 126 for char in bookmark)):
                raise ValueError('RESOURCE_VERSION_BOOKMARK_INVALID')
            return bookmark
        except Exception:
            raise ValueError('RESOURCE_VERSION_BOOKMARK_FAILED') from None

    def _read(self, database, sql):
        request = urllib.request.Request(
            f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{database}/query',
            data=json.dumps({'sql': sql}).encode(), method='POST',
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=30) as response:
                if response.status != 200:
                    raise ValueError('RESOURCE_VERIFY_HTTP_FAILED')
                raw = response.read(LIMIT + 1)
            if len(raw) > LIMIT:
                raise ResponseTooLarge('RESOURCE_VERIFY_RESPONSE_LIMIT')
            result = json.loads(raw)
            if (not isinstance(result, dict) or result.get('success') is not True
                    or result.get('errors') not in (None, []) or not isinstance(result.get('result'), list)
                    or len(result['result']) != 1):
                raise ValueError('RESOURCE_VERIFY_RESULT_INVALID')
            query = result['result'][0]
            if not isinstance(query, dict) or query.get('success') is not True or not isinstance(query.get('results'), list):
                raise ValueError('RESOURCE_VERIFY_RESULT_INVALID')
            return query['results']
        except ResponseTooLarge:
            raise
        except Exception:
            raise ValueError('RESOURCE_VERIFY_READ_FAILED') from None

    def _request(self, database, sql):
        try:
            return self._read(database, sql)
        except ResponseTooLarge:
            match = re.search(r' LIMIT ([1-9][0-9]{0,2}) OFFSET (0|[1-9][0-9]{0,18})$', sql)
            if not match:
                raise
            size, offset = map(int, match.groups())
            if size <= 1:
                raise
            for table in self.tables:
                names = self.columns.get((database, table))
                if names and sql == page_sql(table, names, size, offset):
                    first = size // 2
                    rows = self._request(database, page_sql(table, names, first, offset))
                    if len(rows) < first:
                        return rows
                    return rows + self._request(database, page_sql(table, names, size-first, offset+first))
            raise
