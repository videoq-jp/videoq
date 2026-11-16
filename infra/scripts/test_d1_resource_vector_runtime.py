import copy
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from d1_resource_fence_control import SOURCE, SCHEMA_SQL
from d1_resource_write_fence import plan_fence, install_statements
from d1_resource_vector_runtime import vector_sync, VectorArtifacts
from d1_resource_vector_transport import SOURCES,TARGETS


class Response(io.BytesIO):
    status=200


class VectorRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();self.addCleanup(self.directory.cleanup)
        self.db=sqlite3.connect(':memory:');self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE scenes(id,vector_id,revision,video_id,dimensions);
CREATE TABLE videos(id,user_id);CREATE TABLE scene_staging(run_id,scene_id,vector_id);
CREATE TABLE scene_index_runs(id,video_id,user_id,dimensions,source_revision,status);
CREATE TABLE video_index_versions(video_id,revision);CREATE TABLE video_index_heads(video_id,dimensions,run_id);
CREATE TABLE scene_index_tasks(operation,completed_at,accepted_at,vector_id,scene_id,revision,video_id,user_id,dimensions,embedding);
INSERT INTO videos VALUES(1,'owner');INSERT INTO scenes VALUES('s1','v1','r1',1,768);''')
        self.plan=plan_fence(self.query(SCHEMA_SQL),'a'*32)
        for statement in install_statements(self.plan):self.db.execute(statement)
        self.db.commit()
        self.vector={'id':'v1','values':[0.5]*768,'metadata':{'vector_id':'v1','scene_id':'s1','revision':'r1','video_id':1,'user_id':'owner'}}
        self.indexes={SOURCES[768]:{'v1':copy.deepcopy(self.vector)},SOURCES[1536]:{},TARGETS[768]:{'orphan':{**copy.deepcopy(self.vector),'id':'orphan'}},TARGETS[1536]:{}}
        self.queue=[];self.writes=0;self.lost=False;outer=self
        class Opener:
            def open(self,request,timeout):
                if '/d1/database/' in request.full_url:
                    assert '/database/'+SOURCE+'/' in request.full_url
                    result=[{'success':True,'results':outer.query(json.loads(request.data)['sql'])}]
                else:
                    rest=request.full_url.split('/indexes/')[1]
                    name,action=rest.split('/',1);action=action.split('?')[0];rows=outer.indexes[name]
                    if action=='info':result={'dimensions':768 if name.endswith('768') else 1536,'vectorCount':len(rows),'processedUpToMutation':'stable'}
                    elif action=='list':result={'count':len(rows),'totalCount':len(rows),'isTruncated':False,'vectors':[{'id':key} for key in sorted(rows)]}
                    elif action=='get_by_ids':result=[copy.deepcopy(rows[key]) for key in json.loads(request.data)['ids'] if key in rows]
                    else:
                        assert name in TARGETS.values()
                        outer.writes+=1
                        if action=='upsert':
                            raw=request.data.split(b'\r\n\r\n',1)[1].rsplit(b'\r\n--',1)[0]
                            payload=[json.loads(line) for line in raw.splitlines()]
                        else:payload=json.loads(request.data)['ids']
                        outer.queue.append((name,action,payload))
                        if outer.lost:raise OSError('lost response')
                        result={'mutationId':'mutation-'+str(outer.writes)}
                return Response(json.dumps({'success':True,'result':result}).encode())
        self.opener=Opener()
        self.config={'run':'a'*32,'source':'b'*40,'directory':self.directory.name,'fencePlan':self.plan}
        self.token='synthetic-vector-runtime-token-0123456789'

    def query(self,sql):
        result=self.db.execute(sql)
        return [dict(zip([c[0] for c in result.description],row)) for row in result]

    def run_sync(self,prepare=False,status=False):
        return vector_sync(self.token,self.config,lambda:None,lambda:None,prepare,status,self.opener)

    def prepare(self):
        info=self.run_sync(prepare=True)
        self.config['manifestSha256']=info['manifestSha256']
        return info

    def process(self):
        for name,operation,payload in self.queue:
            if operation=='upsert':self.indexes[name].update({row['id']:row for row in payload})
            else:
                for key in payload:self.indexes[name].pop(key,None)
        self.queue=[]

    def test_owned_private_batches_wait_for_async_values_and_remove_orphans(self):
        self.assertEqual(self.prepare()['vectors'],1)
        self.assertFalse(self.run_sync(status=True)['verified'])
        self.assertFalse(self.run_sync()['verified']);self.assertEqual(self.writes,1)
        self.assertFalse(self.run_sync()['verified']);self.assertEqual(self.writes,1)
        self.process()
        self.assertFalse(self.run_sync()['verified']);self.assertEqual(self.writes,2)
        self.process()
        proof=self.run_sync();self.assertTrue(proof['verified'])
        self.assertTrue(self.run_sync(status=True)['verified'])
        self.assertEqual(self.indexes[TARGETS[768]],{'v1':self.vector})
        self.assertEqual(self.writes,2)

    def test_lost_mutation_response_can_reconcile_after_processing_without_repost(self):
        self.prepare();self.lost=True
        with self.assertRaisesRegex(ValueError,'REQUEST_UNCERTAIN'):self.run_sync()
        self.assertTrue(self.run_sync(status=True)['reconciliationRequired']);self.assertEqual(self.writes,1)
        self.process();self.lost=False
        self.assertFalse(self.run_sync(status=True)['reconciliationRequired'])
        self.run_sync();self.process()
        self.assertTrue(self.run_sync()['verified']);self.assertEqual(self.writes,2)

    def test_source_fence_loss_and_artifact_corruption_prevent_updates(self):
        self.prepare()
        root=Path(self.directory.name)/'vector-sync'
        files=VectorArtifacts(str(root));manifest=files.read('manifest.json')
        path=root/manifest['batches'][0]['file'];path.write_text('[]')
        with self.assertRaisesRegex(ValueError,'ARTIFACT_CHANGED'):self.run_sync()
        self.assertEqual(self.writes,0)
        self.db.execute('DROP TRIGGER "'+next(iter(self.plan['fenceTriggers']))+'"')
        with self.assertRaisesRegex(ValueError,'WRITE_FENCE'):self.run_sync()


if __name__=='__main__':unittest.main()
