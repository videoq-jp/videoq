import io
import json
import unittest
from d1_resource_vector_transport import VectorTransfer, SOURCES, TARGETS
from d1_resource_fence_transport import ACCOUNT


class Response(io.BytesIO):
    status = 200


class VectorTransportTests(unittest.TestCase):
    def setUp(self):
        self.calls, self.guards, self.fail = [], [], False
        outer = self
        class Opener:
            def open(self, request, timeout):
                outer.calls.append(request)
                if outer.fail:
                    raise OSError('PRIVATE_PROVIDER_BODY')
                return Response(json.dumps({'success':True,'result':{'mutationId':'mutation-1'}}).encode())
        self.options = {'token':'synthetic-token-0123456789','assert_owned':lambda: self.guards.append('owned'),
                        'assert_write_safe':lambda *args:self.guards.append(args),'enabled':True,'opener':Opener()}
        self.call = VectorTransfer(**self.options)

    def path(self,index,operation):
        return f'accounts/{ACCOUNT}/vectorize/v2/indexes/{index}/{operation}'

    def test_default_read_only_and_source_write_refusal_never_reach_provider(self):
        for call,index in [(VectorTransfer(**{**self.options,'enabled':False}),TARGETS[768]),(self.call,SOURCES[768])]:
            with self.assertRaisesRegex(ValueError,'CANDIDATE_WRITE'):
                call('POST',self.path(index,'delete_by_ids'),{'ids':['v1']})
        self.assertEqual(self.calls,[])

    def test_candidate_upsert_uses_vectors_multipart_and_preserves_payload(self):
        row = {'id':'v1','values':[0.5]*768,'metadata':{'vector_id':'v1','scene_id':'s1','revision':'r1','video_id':1,'user_id':'owner'}}
        self.call('POST',self.path(TARGETS[768],'upsert'),[row])
        request = self.calls[0]
        self.assertIn('name="vectors"',request.data.decode())
        self.assertIn(json.dumps(row,separators=(',',':')),request.data.decode())
        self.assertEqual(self.guards[1][0:2],(768,'upsert'))
        self.assertEqual(len(self.guards[1][2]),64)

    def test_delete_is_candidate_only_bounded_and_provider_errors_are_not_retried(self):
        self.fail = True
        with self.assertRaisesRegex(ValueError,'^RESOURCE_VECTOR_REQUEST_UNCERTAIN$'):
            self.call('POST',self.path(TARGETS[768],'delete_by_ids'),{'ids':['orphan']})
        self.assertEqual(len(self.calls),1)
        with self.assertRaisesRegex(ValueError,'IDS_REQUIRED'):
            self.call('POST',self.path(TARGETS[768],'delete_by_ids'),{'ids':['duplicate','duplicate']})

    def test_unexpected_index_path_method_or_list_query_refuses_request(self):
        for method,path in [('GET',self.path('other-project','info')),('DELETE',self.path(TARGETS[768],'info')),
                            ('GET',self.path(TARGETS[768],'list?count=1001')),('GET',self.path(TARGETS[768],'info?other=1')),
                            ('GET',self.path(TARGETS[768],'list?count=1&unexpected=1'))]:
            with self.assertRaises(ValueError):
                self.call(method,path)
        self.assertEqual(self.calls,[])

    def test_write_safety_withdrawal_prevents_http(self):
        def unsafe(*args):
            raise ValueError('RESOURCE_SOURCE_NOT_FENCED')
        call = VectorTransfer(**{**self.options,'assert_write_safe':unsafe})
        with self.assertRaisesRegex(ValueError,'NOT_FENCED'):
            call('POST',self.path(TARGETS[1536],'delete_by_ids'),{'ids':['orphan']})
        self.assertEqual(self.calls,[])


if __name__ == '__main__':
    unittest.main()
