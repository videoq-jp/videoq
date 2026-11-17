"""Narrow D1 REST transport: schema reads and exact owner-plan fence SQL only.

No credential discovery, generic SQL, redirects, automatic retries or CLI.
Mutation enablement is explicit; FenceControl remains responsible for ownership.
"""
import json
import urllib.request
from d1_resource_fence_control import SOURCE, TARGET, SCHEMA_SQL
from d1_resource_write_fence import validate_plan, quote

ACCOUNT = '12daec56fdba43f677f2766ee26a5a39'
LIMIT = 2 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class CloudflareFenceQuery:
    def __init__(self, token, plan=None, allow_mutations=False, opener=None, *, allow_source_unfence=False):
        if not isinstance(token, str) or not 20 <= len(token) <= 4096 or any(c in token for c in '\r\n\0'):
            raise ValueError('RESOURCE_D1_TOKEN_REQUIRED')
        if type(allow_mutations) is not bool or type(allow_source_unfence) is not bool or allow_source_unfence and not allow_mutations:
            raise ValueError('RESOURCE_D1_MUTATION_FLAG_REQUIRED')
        self.allowed = {(SOURCE, SCHEMA_SQL), (TARGET, SCHEMA_SQL)}
        if allow_mutations:
            validate_plan(plan)
            if allow_source_unfence:
                self.allowed.update((SOURCE, 'DROP TRIGGER ' + quote(name)) for name in plan['fenceTriggers'])
            else:
                self.allowed.update((SOURCE, sql) for sql in plan['fenceTriggers'].values())
                self.allowed.update((TARGET, 'DROP TRIGGER ' + quote(name)) for name in plan['fenceTriggers'])
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def __call__(self, database, sql):
        if not isinstance(database, str) or not isinstance(sql, str) or (database, sql) not in self.allowed:
            raise ValueError('RESOURCE_D1_QUERY_REFUSED')
        rows = self._request(database, sql)
        if sql == SCHEMA_SQL:
            if any(not isinstance(row, dict) or set(row) != {'type', 'name', 'sql'} for row in rows):
                raise ValueError('RESOURCE_D1_QUERY_FAILED')
        elif rows:
            raise ValueError('RESOURCE_D1_QUERY_FAILED')
        return rows

    def _request(self, database, sql):
        request = urllib.request.Request(
            f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{database}/query',
            data=json.dumps({'sql': sql}).encode(), method='POST',
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=30) as response:
                if response.status != 200:
                    raise ValueError('RESOURCE_D1_REQUEST_FAILED')
                raw = response.read(LIMIT + 1)
            if len(raw) > LIMIT:
                raise ValueError('RESOURCE_D1_RESPONSE_LIMIT')
            result = json.loads(raw)
            if (not isinstance(result, dict) or result.get('success') is not True
                    or result.get('errors') not in (None, []) or not isinstance(result.get('result'), list)
                    or len(result['result']) != 1):
                raise ValueError('RESOURCE_D1_RESULT_INVALID')
            query = result['result'][0]
            if not isinstance(query, dict) or query.get('success') is not True or not isinstance(query.get('results'), list):
                raise ValueError('RESOURCE_D1_RESULT_INVALID')
            rows = query['results']
            return rows
        except Exception:
            # HTTP error bodies/URLs/SQL and application metadata stay private.
            raise ValueError('RESOURCE_D1_QUERY_FAILED') from None
