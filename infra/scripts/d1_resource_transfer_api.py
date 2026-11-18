"""Fixed D1 export/import API; durable operation handling belongs to coordinator.

No retries, credential discovery, signed-URL transfer, CLI or live enablement.
Each API request requires ownership. Export start requires source fencing;
import ingest requires a verified file and a safe, unbound target.
"""
import json
import re
import urllib.request
from d1_resource_fence_transport import CloudflareFenceQuery, NoRedirect, ACCOUNT
from d1_resource_fence_control import SOURCE, TARGET


class TransferApi:
    def __init__(self, token, assert_owned, assert_source_fenced, assert_import_safe, opener=None):
        # Reuse credential validation without enabling fence writes.
        CloudflareFenceQuery(token)
        if not all(callable(value) for value in (assert_owned, assert_source_fenced, assert_import_safe)):
            raise ValueError('RESOURCE_TRANSFER_CONTEXT_REQUIRED')
        self.token, self.owned = token, assert_owned
        self.fenced, self.import_safe = assert_source_fenced, assert_import_safe
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    @staticmethod
    def bookmark(value):
        if not isinstance(value, str) or not 1 <= len(value) <= 512 or any(ord(c) < 33 or ord(c) > 126 for c in value):
            raise ValueError('RESOURCE_TRANSFER_BOOKMARK_REQUIRED')
        return value

    def _request(self, database, operation, payload):
        if (database, operation) not in ((SOURCE, 'export'), (TARGET, 'import')):
            raise ValueError('RESOURCE_TRANSFER_TARGET_REFUSED')
        self.owned()
        if operation == 'export':
            if payload.get('current_bookmark') is None:
                self.fenced()
        elif payload.get('action') in ('init', 'ingest'):
            self.import_safe(payload['action'], payload['etag'], payload.get('filename'))
        req = urllib.request.Request(
            f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{database}/{operation}',
            method='POST', data=json.dumps(payload).encode(),
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(req, timeout=30) as response:
                if response.status not in (200, 202):
                    raise ValueError('TRANSFER_HTTP_FAILED')
                raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ValueError('TRANSFER_RESPONSE_LIMIT')
            value = json.loads(raw)
            result = value.get('result')
            if (value.get('success') is not True or value.get('errors') not in (None, [])
                    or not isinstance(result, dict) or result.get('status') == 'error'
                    or (payload.get('action') != 'init' and
                        (result.get('success') is not True or result.get('type') != operation))
                    or (payload.get('action') == 'init' and
                        (not isinstance(result.get('filename'), str) or not result['filename']
                         or not isinstance(result.get('upload_url'), str)))):
                raise ValueError('TRANSFER_RESULT_INVALID')
        except Exception:
            raise ValueError('RESOURCE_TRANSFER_REQUEST_UNCERTAIN') from None
        self.owned()
        return result

    def export(self, current_bookmark=None):
        # The source DB cannot answer schema probes while an export runs. Its
        # verified fence must be checked before start; later polls retain the
        # same durable bookmark and ownership, never start a replacement task.
        payload = {'output_format': 'polling', 'dump_options': {'compatibility': 'd1'}}
        if current_bookmark is not None:
            payload['current_bookmark'] = self.bookmark(current_bookmark)
        return self._request(SOURCE, 'export', payload)

    def init_import(self, etag):
        self.etag(etag)
        return self._request(TARGET, 'import', {'action': 'init', 'etag': etag})

    @staticmethod
    def etag(value):
        if not isinstance(value, str) or re.fullmatch('[a-f0-9]{32}', value) is None:
            raise ValueError('RESOURCE_TRANSFER_ETAG_REQUIRED')

    def ingest(self, etag, filename):
        self.etag(etag)
        if not isinstance(filename, str) or not 1 <= len(filename) <= 1024 or any(ord(c) < 32 for c in filename):
            raise ValueError('RESOURCE_TRANSFER_FILENAME_REQUIRED')
        return self._request(TARGET, 'import', {'action': 'ingest', 'etag': etag, 'filename': filename})

    def poll_import(self, current_bookmark):
        return self._request(TARGET, 'import', {'action': 'poll', 'current_bookmark': self.bookmark(current_bookmark)})
