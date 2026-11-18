import io
import json
import unittest
from d1_resource_transfer_api import TransferApi
from d1_resource_fence_control import SOURCE, TARGET


class Response(io.BytesIO):
    status = 200


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.calls, self.guards = [], []
        self.error, self.allow = False, True
        outer = self
        class Opener:
            def open(self, request, timeout):
                outer.calls.append((request.full_url, json.loads(request.data)))
                if outer.error:
                    raise OSError('PRIVATE_PROVIDER_BODY')
                operation = request.full_url.rsplit('/', 1)[1]
                if json.loads(request.data).get('action') == 'init':
                    return Response(json.dumps({'success': True, 'result': {'filename': 'target-hash.sql', 'upload_url': 'https://upload.test'}}).encode())
                return Response(json.dumps({'success': True, 'result': {'type': operation, 'success': True, 'at_bookmark': 'bookmark-1'}}).encode())
        def owned():
            if not self.allow:
                raise ValueError('OWNERSHIP_LOST')
        self.api = TransferApi('synthetic-token-0123456789', owned,
                               lambda: self.guards.append('fenced'),
                               lambda *args: self.guards.append(args), Opener())

    def test_export_polls_the_same_bookmark_without_reprobing_locked_source(self):
        self.api.export()
        self.api.export('bookmark-1')
        self.assertEqual(self.guards, ['fenced'])
        self.assertTrue(all('/database/' + SOURCE + '/export' in url for url, _ in self.calls))
        self.assertNotIn('current_bookmark', self.calls[0][1])
        self.assertEqual(self.calls[1][1]['current_bookmark'], 'bookmark-1')

    def test_import_stages_are_fixed_to_target_and_require_file_safety(self):
        etag = 'a' * 32
        self.api.init_import(etag)
        self.api.ingest(etag, 'target-hash.sql')
        self.api.poll_import('bookmark-1')
        self.assertTrue(all('/database/' + TARGET + '/import' in url for url, _ in self.calls))
        self.assertEqual(self.guards, [('init', etag, None), ('ingest', etag, 'target-hash.sql')])
        self.assertEqual([body['action'] for _, body in self.calls], ['init', 'ingest', 'poll'])

    def test_lost_response_is_uncertain_and_never_retried(self):
        self.error = True
        with self.assertRaisesRegex(ValueError, '^RESOURCE_TRANSFER_REQUEST_UNCERTAIN$'):
            self.api.ingest('a' * 32, 'target.sql')
        self.assertEqual(len(self.calls), 1)

    def test_wrong_targets_invalid_handles_and_lost_ownership_refuse_requests(self):
        for action in [lambda: self.api._request(SOURCE, 'import', {}), lambda: self.api._request(TARGET, 'export', {}),
                       lambda: self.api.export(''), lambda: self.api.poll_import('x\n'),
                       lambda: self.api.init_import('invalid'), lambda: self.api.ingest('a' * 32, '')]:
            with self.assertRaises(ValueError):
                action()
        self.allow = False
        with self.assertRaisesRegex(ValueError, 'OWNERSHIP'):
            self.api.export('bookmark-1')
        self.assertEqual(self.calls, [])

    def test_missing_ownership_or_safety_verifier_cannot_construct_transport(self):
        with self.assertRaises(ValueError):
            TransferApi('synthetic-token-0123456789', None, lambda: None, lambda *args: None)

    def test_http_202_active_export_is_accepted_without_restarting(self):
        class Accepted:
            def open(inner,request,timeout):
                response=Response(json.dumps({'success':True,'result':{'success':True,'type':'export','status':'active','at_bookmark':'export-active'}}).encode())
                response.status=202
                return response
        self.api.opener=Accepted()
        self.assertEqual(self.api.export()['at_bookmark'],'export-active')
        self.assertEqual(self.guards,['fenced'])


if __name__ == '__main__':
    unittest.main()
