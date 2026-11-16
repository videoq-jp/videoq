"""Fixed Vectorize source reads and candidate-only mutations; no retries/CLI."""
import json
import re
import urllib.parse
import urllib.request
import uuid
from d1_resource_fence_transport import NoRedirect, CloudflareFenceQuery, ACCOUNT
from d1_resource_write_fence import fingerprint
from d1_resource_vector_plan import plan_vectors

SOURCES = {768:'videoq-scenes-migration-v3-768',1536:'videoq-scenes-migration-v3-1536'}
TARGETS = {768:'videoq-prod-scenes-768',1536:'videoq-prod-scenes-1536'}


def identifiers(value, limit):
    if (not isinstance(value, list) or not 1 <= len(value) <= limit
            or any(not isinstance(item, str) or not 1 <= len(item.encode()) <= 64 for item in value) or len(set(value)) != len(value)):
        raise ValueError('RESOURCE_VECTOR_IDS_REQUIRED')


class VectorTransfer:
    def __init__(self, token, assert_owned, assert_write_safe=None, enabled=False, opener=None):
        CloudflareFenceQuery(token)
        if not callable(assert_owned) or type(enabled) is not bool or enabled and not callable(assert_write_safe):
            raise ValueError('RESOURCE_VECTOR_TRANSPORT_CONTEXT_REQUIRED')
        self.token, self.owned, self.safe, self.enabled = token, assert_owned, assert_write_safe, enabled
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def __call__(self, method, path, payload=None):
        prefix = f'accounts/{ACCOUNT}/vectorize/v2/indexes/'
        found = re.fullmatch(re.escape(prefix) + r'([a-z0-9-]+)/(info|list|get_by_ids|upsert|delete_by_ids)(\?.*)?', path)
        if not found:
            raise ValueError('RESOURCE_VECTOR_ENDPOINT_REFUSED')
        name, operation, query = found.groups()
        dimensions = next((d for d in SOURCES if name in (SOURCES[d], TARGETS[d])), None)
        if dimensions is None:
            raise ValueError('RESOURCE_VECTOR_ENDPOINT_REFUSED')
        mutation = operation in ('upsert','delete_by_ids')
        if method != ('GET' if operation in ('info','list') else 'POST') or query and operation != 'list':
            raise ValueError('RESOURCE_VECTOR_METHOD_REFUSED')
        if operation == 'list':
            params = urllib.parse.parse_qs((query or '')[1:], keep_blank_values=True)
            if (set(params) - {'count','cursor'} or len(params.get('count',[])) != 1
                    or not params['count'][0].isascii() or not params['count'][0].isdigit()
                    or not 1 <= int(params['count'][0]) <= 1000
                    or 'cursor' in params and (len(params['cursor']) != 1 or not 1 <= len(params['cursor'][0]) <= 4096)):
                raise ValueError('RESOURCE_VECTOR_LIST_QUERY_REFUSED')
        body, content_type = None, 'application/json'
        if operation in ('get_by_ids','delete_by_ids'):
            if not isinstance(payload, dict) or set(payload) != {'ids'}:
                raise ValueError('RESOURCE_VECTOR_IDS_REQUIRED')
            identifiers(payload['ids'],20 if operation=='get_by_ids' else 500)
            body = json.dumps(payload,allow_nan=False).encode()
        elif operation == 'upsert':
            if not isinstance(payload,list) or not 1 <= len(payload) <= 500:
                raise ValueError('RESOURCE_VECTOR_BATCH_REQUIRED')
            # Reuse the exact scope/value validator. The caller's independent
            # D1 authority check remains mandatory in assert_write_safe.
            authority = []
            for row in payload:
                metadata = row.get('metadata',{}) if isinstance(row,dict) else {}
                authority.append({'vector_id':row.get('id') if isinstance(row,dict) else None,'scene_id':metadata.get('scene_id'),
                    'revision':metadata.get('revision'),'video_id':int(metadata['video_id']) if type(metadata.get('video_id')) in (int,float) and float(metadata['video_id']).is_integer() else metadata.get('video_id'),'user_id':metadata.get('user_id'),
                    'dimensions':dimensions,'legacy':metadata.get('vector_id') is None,'pending_payload':False})
            source = {768:[],1536:[]}; source[dimensions] = payload
            validated = plan_vectors(authority,source,{768:[],1536:[]})
            payload = next(row['upsert'] for row in validated['indexes'] if row['dimensions']==dimensions)
            boundary = 'videoq-vector-' + uuid.uuid4().hex
            data = ''.join(json.dumps(row,separators=(',',':'),allow_nan=False)+'\n' for row in payload).encode()
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="vectors"; filename="vectors.ndjson"\r\nContent-Type: application/x-ndjson\r\n\r\n'.encode()
                    + data + f'\r\n--{boundary}--\r\n'.encode())
            content_type = 'multipart/form-data; boundary=' + boundary
        elif payload is not None:
            raise ValueError('RESOURCE_VECTOR_READ_PAYLOAD_REFUSED')
        if mutation and (not self.enabled or name != TARGETS[dimensions]):
            raise ValueError('RESOURCE_VECTOR_CANDIDATE_WRITE_REQUIRED')
        self.owned()
        if mutation:
            self.safe(dimensions,operation,fingerprint(payload))
        req = urllib.request.Request('https://api.cloudflare.com/client/v4/'+path,method=method,data=body,
            headers={'Authorization':'Bearer '+self.token,'Content-Type':content_type})
        try:
            with self.opener.open(req,timeout=30) as response:
                if response.status != 200:
                    raise ValueError('HTTP_FAILED')
                raw = response.read(8*1024*1024+1)
            if len(raw)>8*1024*1024:
                raise ValueError('RESPONSE_LIMIT')
            parsed = json.loads(raw)
            if parsed.get('success') is not True or parsed.get('errors') not in (None,[]) or 'result' not in parsed:
                raise ValueError('RESULT_INVALID')
            result = parsed['result']
            if mutation and (not isinstance(result,dict) or not isinstance(result.get('mutationId'),str) or not result['mutationId']):
                raise ValueError('MUTATION_HANDLE_REQUIRED')
        except Exception:
            raise ValueError('RESOURCE_VECTOR_REQUEST_UNCERTAIN') from None
        self.owned()
        return result
