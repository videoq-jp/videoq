import io
import json
import unittest
from urllib.error import HTTPError
from d1_resource_fence_control import SOURCE, TARGET, SCHEMA_SQL
from d1_resource_fence_transport import CloudflareFenceQuery, NoRedirect, LIMIT
from d1_resource_write_fence import plan_fence, quote

TOKEN = 'synthetic-fence-token-0123456789'
PLAN = plan_fence([{'type': 'table', 'name': 'users', 'sql': 'CREATE TABLE users(id INTEGER)'}], 'a' * 32)


class Response(io.BytesIO):
    status = 200


class Opener:
    def __init__(self, value):
        self.value, self.calls = value, []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if isinstance(self.value, Exception):
            raise self.value
        return Response(self.value)


def payload(rows=None, **kwargs):
    return json.dumps({'success': True, 'result': [{'success': True, 'results': rows or []}], **kwargs}).encode()


class TransportTests(unittest.TestCase):
    def test_schema_read_uses_fixed_https_database_and_bounded_request(self):
        rows = [{'type': 'table', 'name': 'users', 'sql': 'CREATE TABLE users(id INTEGER)'}]
        opener = Opener(payload(rows))
        query = CloudflareFenceQuery(TOKEN, opener=opener)
        self.assertEqual(query(SOURCE, SCHEMA_SQL), rows)
        req, timeout = opener.calls[0]
        self.assertEqual(req.full_url, f'https://api.cloudflare.com/client/v4/accounts/12daec56fdba43f677f2766ee26a5a39/d1/database/{SOURCE}/query')
        self.assertEqual(json.loads(req.data), {'sql': SCHEMA_SQL})
        self.assertEqual(timeout, 30)
        self.assertEqual(req.get_header('Authorization'), 'Bearer ' + TOKEN)

    def test_mutations_are_disabled_by_default_and_exactly_bound_to_owner_plan(self):
        sql = next(iter(PLAN['fenceTriggers'].values()))
        opener = Opener(payload())
        with self.assertRaisesRegex(ValueError, 'REFUSED'):
            CloudflareFenceQuery(TOKEN, opener=opener)(SOURCE, sql)
        enabled = CloudflareFenceQuery(TOKEN, PLAN, True, opener)
        enabled(SOURCE, sql)
        drop = 'DROP TRIGGER ' + quote(next(iter(PLAN['fenceTriggers'])))
        enabled(TARGET, drop)
        for database, statement in [(TARGET, sql), (SOURCE, drop), ('other', SCHEMA_SQL), (SOURCE, 'DELETE FROM users'), (SOURCE, sql + '; DROP TABLE users')]:
            with self.assertRaisesRegex(ValueError, 'REFUSED'):
                enabled(database, statement)
        self.assertEqual(len(opener.calls), 2)

    def test_provider_failures_are_sanitized_and_never_retried(self):
        error = HTTPError('https://private.invalid', 403, 'PRIVATE_ERROR', {}, io.BytesIO(b'PRIVATE_BODY'))
        self.addCleanup(error.close)
        for value in [error, b'PRIVATE_BODY', payload(success=False), payload(errors=[{'message': 'PRIVATE_BODY'}]), b'x' * (LIMIT + 1)]:
            opener = Opener(value)
            with self.assertRaisesRegex(ValueError, '^RESOURCE_D1_QUERY_FAILED$'):
                CloudflareFenceQuery(TOKEN, opener=opener)(SOURCE, SCHEMA_SQL)
            self.assertEqual(len(opener.calls), 1)

    def test_invalid_result_shapes_and_unexpected_schema_fields_are_refused(self):
        for value in [b'[]', payload([{'name': 'users'}]), payload(result=[]), payload(result=[{'success': False, 'results': []}]), payload(result=[{'success': True}])]:
            with self.assertRaisesRegex(ValueError, 'QUERY_FAILED'):
                CloudflareFenceQuery(TOKEN, opener=Opener(value))(SOURCE, SCHEMA_SQL)

    def test_redirects_and_invalid_credentials_are_refused(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid'))
        for token in [None, '', 'short', TOKEN + '\n', TOKEN + '\0']:
            with self.assertRaisesRegex(ValueError, 'TOKEN_REQUIRED'):
                CloudflareFenceQuery(token)
        with self.assertRaises(ValueError):
            CloudflareFenceQuery(TOKEN, allow_mutations=True)


if __name__ == '__main__':
    unittest.main()
