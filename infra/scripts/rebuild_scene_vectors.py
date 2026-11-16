"""Prepare Vectorize recovery from a fresh private D1 SQL export.

No database, index, IAM or credential mutations. Paid model calls require --execute
and an explicitly enabled, version-pinned embedding-only Lambda. Output is private
NDJSON for upload into a NEW index, never an in-place production overwrite.
"""
from __future__ import annotations
from contextlib import closing
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/worker'))
from worker_python.remote_search_evaluation import prepare_remote, validate_target
from worker_python.pipeline.embedding_contract import EmbeddingConfig, validate_embedding

REGION = 'ap-northeast-1'
EMBEDDING = {'provider':'openai','model':'openai/text-embedding-3-small','profile':'openai',
             'dimensions':1536,'baseUrl':'https://openrouter.ai/api/v1','authentication':'workload-federation'}

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',',':')).encode()).hexdigest()

def private_directory(path):
    if path.is_symlink() or not path.is_dir() or stat.S_IMODE(path.stat().st_mode) != 0o700:
        raise ValueError('PRIVATE_DIRECTORY_REQUIRED')

def private_file(path):
    private_directory(path.parent)
    if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError('PRIVATE_FILE_REQUIRED')

def read_scenes(source):
    private_file(source)
    with closing(sqlite3.connect(':memory:')) as db:
        # The input must be a trusted provider-generated export; additionally block
        # attaching local databases or extensions if a source schema is unexpected.
        db.set_authorizer(lambda action,*_: sqlite3.SQLITE_DENY if action in {sqlite3.SQLITE_ATTACH,sqlite3.SQLITE_DETACH} else sqlite3.SQLITE_OK)
        db.executescript(source.read_text())
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('SOURCE_INTEGRITY_FAILED')
        db.row_factory = sqlite3.Row
        rows = [dict(r) for r in db.execute('SELECT s.id AS sceneId,s.video_id AS videoId,v.user_id AS userId,s.content,s.dimensions,s.revision,coalesce(s.vector_id,s.id) AS vectorId FROM scenes s JOIN videos v ON v.id=s.video_id ORDER BY s.dimensions,s.id')]
        if len(rows) != db.execute('SELECT count(*) FROM scenes').fetchone()[0]:
            raise ValueError('ORPHANED_SCENES')
    if len(rows) != len({(r['dimensions'],r['vectorId']) for r in rows}):
        raise ValueError('DUPLICATE_VECTOR_ID')
    for r in rows:
        # Query/document requests have identical provider input for this OpenAI
        # profile. Never use the query-only runtime for prefixed 768d profiles.
        if r['dimensions'] != 1536:
            raise ValueError('DOCUMENT_EMBEDDER_REQUIRED_FOR_OTHER_PROFILE')
        if not isinstance(r['content'],str) or not r['content'].strip() or len(r['content'])>8000:
            raise ValueError('INVALID_SCENE_CONTENT')
        if type(r['videoId']) is not int or r['videoId']<1 or not r['userId'] or not r['revision'] or not r['vectorId']:
            raise ValueError('INVALID_SCENE_IDENTITY')
    return rows

class AwsCliLambda:
    """Uses operator credentials only; tokens are exchanged inside Lambda."""
    def _call(self, action, **payload):
        r = subprocess.run(['aws','lambda',action,'--region',REGION,'--endpoint-url',f'https://lambda.{REGION}.amazonaws.com','--cli-input-json',json.dumps(payload),'--output','json','--no-cli-pager'],capture_output=True,text=True)
        if r.returncode: raise RuntimeError('LAMBDA_METADATA_REQUEST_FAILED')
        return json.loads(r.stdout)
    def get_function(self, **payload): return self._call('get-function',**payload)
    def get_function_concurrency(self, **payload): return self._call('get-function-concurrency',**payload)
    def invoke(self, **payload):
        with tempfile.TemporaryDirectory(prefix='videoq-vector-recovery-') as directory:
            request,response=Path(directory)/'request.json',Path(directory)/'response.json'
            request.write_bytes(payload['Payload']);request.chmod(0o600)
            env={**os.environ,'AWS_MAX_ATTEMPTS':'1','AWS_PAGER':'','AWS_CLI_AUTO_PROMPT':'off'}
            args=['aws','lambda','invoke','--region',REGION,'--endpoint-url',f'https://lambda.{REGION}.amazonaws.com','--function-name',payload['FunctionName'],'--qualifier',payload['Qualifier'],'--invocation-type','RequestResponse','--log-type','None','--payload','fileb://'+str(request),'--cli-read-timeout','330','--cli-connect-timeout','10','--output','json','--no-cli-pager',str(response)]
            r=subprocess.run(args,capture_output=True,text=True,env=env)
            if r.returncode: raise RuntimeError('LAMBDA_INVOCATION_FAILED_NO_AUTOMATIC_RETRY')
            return {**json.loads(r.stdout),'Payload':io.BytesIO(response.read_bytes())}

def prepare(source, output, target_path=None, execute=False, client=None):
    private_directory(output)
    rows=read_scenes(source);corpus=digest(rows)
    inventory=output/'scene-inventory.private.json'
    if inventory.exists():
        private_file(inventory)
        if json.loads(inventory.read_text()) != rows: raise ValueError('SOURCE_CHANGED_USE_NEW_DIRECTORY')
    else: inventory.write_text(json.dumps(rows,ensure_ascii=False));inventory.chmod(0o600)
    manifests=[]
    for offset in range(0,len(rows),1000):
        manifest={'version':1,'cohort':'production-rehearsal','corpusSha256':corpus,'embedding':EMBEDDING,'samples':1,
                  'cases':[{'id':'s'+str(offset+i),'question':r['content'],'userId':r['userId'],'videoIds':[r['videoId']],'limit':5} for i,r in enumerate(rows[offset:offset+1000])]}
        path=output/f'manifest-{offset:06d}.json'
        if path.exists():
            private_file(path)
            if json.loads(path.read_text()) != manifest: raise ValueError('MANIFEST_CHANGED')
        else: path.write_text(json.dumps(manifest,ensure_ascii=False));path.chmod(0o600)
        manifests.append((path,manifest))
    if not execute:
        return {'status':'prepared','scenes':len(rows),'corpusSha256':corpus,'manifests':len(manifests),'modelCallsMade':False}
    if target_path is None: raise ValueError('PINNED_LAMBDA_TARGET_REQUIRED')
    private_file(target_path);target=validate_target(json.loads(target_path.read_text()))
    if client is None:
        identity=json.loads(subprocess.check_output(['aws','sts','get-caller-identity','--output','json','--no-cli-pager'],stderr=subprocess.PIPE))
        if identity['Account']!='257240362763' or ':assumed-role/videoq-worker-prod/' in identity['Arn']: raise ValueError('OPERATOR_IDENTITY_REQUIRED')
        client=AwsCliLambda()
    vectors=[]
    for path,manifest in manifests:
        destination=output/(path.stem+'-vectors.json')
        if not destination.exists(): prepare_remote(path,destination,target_path,execute=True,client=client)
        private_file(destination);result=json.loads(destination.read_text());generation=result['generation']
        if generation['manifest_sha256']!=digest(manifest) or generation['runtime']!={key:target[key] for key in ['functionArn','functionVersion','imageUri','roleArn']} or generation['embedding']!=EMBEDDING or generation['input_type']!='query' or generation['case_ids']!=[c['id'] for c in manifest['cases']] or len(result['cases'])!=len(manifest['cases']): raise ValueError('EMBEDDING_PROVENANCE_MISMATCH')
        offset=len(vectors)
        for i,case in enumerate(result['cases']):
            row=rows[offset+i]
            if case['userId']!=row['userId'] or case['videoIds']!=[row['videoId']]: raise ValueError('EMBEDDING_OWNER_MISMATCH')
            values=validate_embedding(case['queryEmbedding'],EmbeddingConfig('openai',EMBEDDING['model']))
            vectors.append({'id':row['vectorId'],'values':values,'metadata':{'user_id':row['userId'],'video_id':row['videoId'],'scene_id':row['sceneId'],'revision':row['revision'],'vector_id':row['vectorId']}})
    destination=output/'recovered-vectors.ndjson'
    if destination.exists(): raise ValueError('RECOVERY_OUTPUT_ALREADY_EXISTS')
    with destination.open('x') as f:
        os.chmod(destination,0o600)
        for vector in vectors: f.write(json.dumps(vector,separators=(',',':'))+'\n')
    proof={'status':'generated','scenes':len(rows),'corpusSha256':corpus,'vectorsSha256':hashlib.sha256(destination.read_bytes()).hexdigest(),'modelCallsMade':bool(rows),'inputSource':'D1 scene content; no existing vectors','productionDatabaseMutations':False,'productionIndexMutations':False}
    (output/'generation-verified.json').write_text(json.dumps(proof,indent=2));return proof

def main():
    os.umask(0o077);p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-sql',type=Path,required=True);p.add_argument('--output-dir',type=Path,required=True)
    p.add_argument('--target',type=Path);p.add_argument('--execute',action='store_true');args=p.parse_args()
    try: print(json.dumps(prepare(args.source_sql,args.output_dir,args.target,args.execute)))
    except Exception:
        # Provider errors, SQL contents, credentials and model payloads stay private.
        print('SCENE_VECTOR_RECOVERY_FAILED',file=sys.stderr);return 1
    return 0
if __name__=='__main__': raise SystemExit(main())
