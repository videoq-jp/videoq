"""One immutable candidate batch with durable intent and exact async readback.

No credential discovery or automatic replay. The caller must bind journal,
payload and authority under the owned executor/local lock. A lost acceptance
response reconciles by values; unmatched state remains unknown without reissue.
"""
from d1_resource_write_fence import fingerprint
from d1_resource_vector_transport import TARGETS, identifiers, ACCOUNT


class VectorBatch:
    def __init__(self, journal, call, dimensions, operation, payload, assert_safe):
        if dimensions not in TARGETS or operation not in ('upsert','delete_by_ids') or not callable(call) or not callable(assert_safe):
            raise ValueError('RESOURCE_VECTOR_BATCH_CONTEXT_REQUIRED')
        if journal.phases != ('intent','accepted','verified'):
            raise ValueError('RESOURCE_VECTOR_BATCH_JOURNAL_REQUIRED')
        self.ids = [row['id'] for row in payload] if operation=='upsert' else payload['ids']
        identifiers(self.ids,500)
        self.journal,self.call,self.dimensions,self.operation,self.payload,self.safe = journal,call,dimensions,operation,payload,assert_safe
        self.context = {'dimensions':dimensions,'operation':operation,'payloadSha256':fingerprint(payload)}
        self.base = f'accounts/{ACCOUNT}/vectorize/v2/indexes/{TARGETS[dimensions]}'

    def readback(self):
        self.safe()
        rows = []
        for offset in range(0,len(self.ids),20):
            self.safe()
            batch = self.ids[offset:offset+20]
            found = self.call('POST',self.base+'/get_by_ids',{'ids':batch})
            if (not isinstance(found,list) or any(not isinstance(row,dict) or row.get('id') not in batch for row in found)
                    or len({row['id'] for row in found}) != len(found)):
                raise ValueError('RESOURCE_VECTOR_BATCH_READBACK_INVALID')
            rows.extend({key:value for key,value in row.items() if key!='namespace'} if row.get('namespace') in (None,'') else row for row in found)
        rows.sort(key=lambda row:row['id'])
        expected = sorted(self.payload,key=lambda row:row['id']) if self.operation=='upsert' else []
        return fingerprint(rows)==fingerprint(expected),fingerprint(rows)

    def run_next(self):
        self.safe()
        records = self.journal.read()
        phase = records[-1]['phase'] if records else None
        if records and records[0]['value'] != self.context:
            raise ValueError('RESOURCE_VECTOR_BATCH_PAYLOAD_CHANGED')
        matched,sha = self.readback()
        if phase=='verified':
            if not matched or records[-1]['value']!={**self.context,'readbackSha256':sha}:
                raise ValueError('RESOURCE_VECTOR_BATCH_VERIFICATION_CHANGED')
            return {'verified':True,'receiptSha256':fingerprint(records[-1]['value'])}
        fresh = phase is None
        if fresh:
            self.journal.save('intent',self.context)
        self.safe()
        if matched:
            if phase!='accepted':
                self.journal.save('accepted',{'mutationId':None,'reconciledByReadback':True})
            proof = {**self.context,'readbackSha256':sha}
            self.journal.save('verified',proof)
            return {'verified':True,'receiptSha256':fingerprint(proof)}
        if not fresh:
            return {'verified':False,'reconciliationRequired':phase=='intent'}
        # This is the sole mutation attempt for this recorded intent. Neither
        # pending processing nor an uncertain response authorizes another POST.
        result = self.call('POST',self.base+'/'+self.operation,self.payload)
        if not isinstance(result,dict) or not isinstance(result.get('mutationId'),str) or not result['mutationId']:
            raise ValueError('RESOURCE_VECTOR_BATCH_MUTATION_HANDLE_REQUIRED')
        self.safe()
        self.journal.save('accepted',{'mutationId':result['mutationId'],'reconciledByReadback':False})
        return {'verified':False,'reconciliationRequired':False}
