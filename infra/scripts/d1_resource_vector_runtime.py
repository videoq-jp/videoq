"""Private vector payloads plus owned, journaled candidate synchronization.

The coordinator supplies source fencing/ownership and candidate safety. No
model calls, outbox writes, binding promotion, recovery override or live CLI.
"""
import json
import os
from pathlib import Path
import re
import stat
from d1_resource_files import PrivateSqlFiles
from d1_resource_executor_lock import ExecutorLock
from d1_resource_transfer_journal import TransferJournal
from d1_resource_vector_batches import VectorBatch
from d1_resource_vector_transport import VectorTransfer, SOURCES, TARGETS
from d1_resource_vector_plan import read_authority, plan_vectors, candidate_status
from d1_resource_vector_authority_transport import VectorAuthorityQuery
from d1_resource_fence_control import SOURCE, SCHEMA_SQL
from d1_resource_fence_transport import CloudflareFenceQuery
from d1_resource_write_fence import fingerprint, assert_fenced, validate_plan
from snapshot_scene_vectors import snapshot_index

MAX_BYTES = 64 * 1024 * 1024


class VectorArtifacts:
    def __init__(self, directory):
        self.private = PrivateSqlFiles(directory)

    def path(self, name):
        if not isinstance(name,str) or re.fullmatch(r'manifest\.json|batch-[0-9]{4}\.json',name) is None:
            raise ValueError('RESOURCE_VECTOR_ARTIFACT_NAME_REQUIRED')
        self.private.checked()
        return self.private.root / name

    def read(self, name):
        fd = os.open(self.path(name),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(fd,'rb') as handle:
            before=os.fstat(handle.fileno())
            if (not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode)!=0o600
                    or before.st_uid!=os.getuid() or before.st_size>MAX_BYTES):
                raise ValueError('RESOURCE_VECTOR_ARTIFACT_UNSAFE')
            raw=handle.read(MAX_BYTES+1)
            after=os.fstat(handle.fileno())
        self.private.checked()
        if len(raw)!=before.st_size or len(raw)>MAX_BYTES or (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns):
            raise ValueError('RESOURCE_VECTOR_ARTIFACT_CHANGED')
        try:
            return json.loads(raw)
        except Exception:
            raise ValueError('RESOURCE_VECTOR_ARTIFACT_CORRUPT') from None

    def save(self, name, value):
        try:
            existing=self.read(name)
        except FileNotFoundError:
            existing=None
        else:
            if fingerprint(existing)!=fingerprint(value):
                raise ValueError('RESOURCE_VECTOR_ARTIFACT_REPLACEMENT_REFUSED')
            return
        raw=json.dumps(value,separators=(',',':'),allow_nan=False).encode()
        if len(raw)>MAX_BYTES:
            raise ValueError('RESOURCE_VECTOR_ARTIFACT_LIMIT')
        fd=os.open(self.path(name),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as handle:
            handle.write(raw);handle.flush();os.fsync(handle.fileno())
        self.private.sync_directory()
        if fingerprint(self.read(name))!=fingerprint(value):
            raise ValueError('RESOURCE_VECTOR_ARTIFACT_NOT_DURABLE')


def vector_sync(token, config, owned, assert_candidate_safe, prepare=False, status=False, opener=None):
    expected={'run','source','directory','fencePlan'} | (set() if prepare else {'manifestSha256'})
    if not isinstance(config,dict) or set(config)!=expected or not callable(owned) or not callable(assert_candidate_safe) or type(prepare) is not bool or type(status) is not bool or prepare and status:
        raise ValueError('RESOURCE_VECTOR_RUNTIME_CONTEXT_REQUIRED')
    plan=config['fencePlan'];validate_plan(plan)
    if plan['owner']!=config['run'] or re.fullmatch('[a-f0-9]{40}',config['source']) is None:
        raise ValueError('RESOURCE_VECTOR_RUNTIME_OWNER_REQUIRED')
    owned()
    with ExecutorLock(config['directory']) as lock:
        def source_safe():
            lock.check();owned()
            assert_fenced(CloudflareFenceQuery(token,opener=opener)(SOURCE,SCHEMA_SQL),plan)
        source_safe()
        base=PrivateSqlFiles(config['directory'])
        root=base.root/'vector-sync'
        if prepare:
            root.mkdir(mode=0o700,exist_ok=True);base.sync_directory()
        artifacts=VectorArtifacts(str(root))
        authority=read_authority(VectorAuthorityQuery(token,opener=opener),source_safe)
        authority_sha=fingerprint(sorted(authority,key=lambda row:(row['dimensions'],row['vector_id'])))
        reader=VectorTransfer(token,owned,opener=opener)
        context={'run':config['run'],'source':config['source'],'fencePlanSha256':fingerprint(plan)}
        if prepare:
            try:
                manifest=artifacts.read('manifest.json')
            except FileNotFoundError:
                source_vectors={};candidate_vectors={}
                for dimensions in (768,1536):
                    source_safe()
                    source_vectors[dimensions],_=snapshot_index(reader,dimensions)
                    candidate_vectors[dimensions],_=snapshot_index(reader,dimensions,TARGETS[dimensions])
                desired=plan_vectors(authority,source_vectors,candidate_vectors)
                batches=[];indexes=[]
                for index in desired['indexes']:
                    dimensions=index['dimensions']
                    indexes.append({'dimensions':dimensions,'count':len(index['upsert']),'deferred':len(index['deferred']),'vectorsSha256':index['vectorsSha256']})
                    for operation,values in [('upsert',index['upsert']),('delete_by_ids',index['delete'])]:
                        for offset in range(0,len(values),500):
                            if len(batches)>=10000:
                                raise ValueError('RESOURCE_VECTOR_BATCH_LIMIT')
                            payload=values[offset:offset+500] if operation=='upsert' else {'ids':values[offset:offset+500]}
                            name=f'batch-{len(batches):04d}.json'
                            artifacts.save(name,payload)
                            batches.append({'file':name,'dimensions':dimensions,'operation':operation,'sha256':fingerprint(payload)})
                source_safe()
                manifest={'version':1,'context':context,'authoritySha256':desired['authoritySha256'],'indexes':indexes,'batches':batches}
                artifacts.save('manifest.json',manifest)
        else:
            manifest=artifacts.read('manifest.json')
            if fingerprint(manifest)!=config['manifestSha256']:
                raise ValueError('RESOURCE_VECTOR_MANIFEST_CHANGED')
        if manifest.get('version')!=1 or manifest.get('context')!=context or manifest.get('authoritySha256')!=authority_sha:
            raise ValueError('RESOURCE_VECTOR_AUTHORITY_CHANGED')
        manifest_sha=fingerprint(manifest)
        if prepare:
            return {'manifestSha256':manifest_sha,'batches':len(manifest['batches']),
                    'vectors':sum(row['count'] for row in manifest['indexes']),'deferredPending':sum(row['deferred'] for row in manifest['indexes'])}
        expected_vectors={768:[],1536:[]}
        journals=root/'journals'
        if not status:
            journals.mkdir(mode=0o700,exist_ok=True);artifacts.private.sync_directory()
        if journals.exists() or journals.is_symlink():
            PrivateSqlFiles(str(journals))
        for i,batch in enumerate(manifest['batches']):
            payload=artifacts.read(batch['file'])
            if fingerprint(payload)!=batch['sha256']:
                raise ValueError('RESOURCE_VECTOR_BATCH_ARTIFACT_CHANGED')
            if batch['operation']=='upsert':
                expected_vectors[batch['dimensions']].extend(payload)
            journal_root=journals/f'{i:04d}'
            if status and not journal_root.exists():
                return {'verified':False,'reconciliationRequired':False}
            if not status:
                journal_root.mkdir(mode=0o700,exist_ok=True)
                directory=os.open(journals,os.O_RDONLY|os.O_NOFOLLOW)
                try:os.fsync(directory)
                finally:os.close(directory)
            journal=TransferJournal(str(journal_root),config['run'],config['source'],fingerprint({'manifest':manifest_sha,'batch':batch}),phases=('intent','accepted','verified'))
            records=journal.read()
            if status:
                if not records or records[-1]['phase']!='verified':
                    if records and records[-1]['phase']=='intent':
                        matched,_=VectorBatch(journal,reader,batch['dimensions'],batch['operation'],payload,source_safe).readback()
                        return {'verified':False,'reconciliationRequired':not matched}
                    return {'verified':False,'reconciliationRequired':False}
            else:
                def safe():
                    source_safe();assert_candidate_safe()
                def write_safe(dimensions,operation,sha):
                    safe()
                    if dimensions!=batch['dimensions'] or operation!=batch['operation'] or sha!=batch['sha256']:
                        raise ValueError('RESOURCE_VECTOR_BATCH_SCOPE_CHANGED')
                call=VectorTransfer(token,owned,write_safe,enabled=True,opener=opener)
                result=VectorBatch(journal,call,batch['dimensions'],batch['operation'],payload,safe).run_next()
                if not result['verified']:
                    return result
        actual={}
        for dimensions in (768,1536):
            source_safe()
            actual[dimensions],_=snapshot_index(reader,dimensions,TARGETS[dimensions])
        verification_plan={'version':1,'indexes':[{'dimensions':row['dimensions'],'upsert':expected_vectors[row['dimensions']],
            'vectorsSha256':row['vectorsSha256'],'deferred':[None]*row['deferred']} for row in manifest['indexes']]}
        proof=candidate_status(verification_plan,actual)
        source_safe()
        if not proof['verified']:
            return {'verified':False,'reconciliationRequired':True}
        return {'verified':True,'receiptSha256':fingerprint({'manifestSha256':manifest_sha,'readback':proof}),'deferredPending':sum(row['deferred'] for row in manifest['indexes'])}
