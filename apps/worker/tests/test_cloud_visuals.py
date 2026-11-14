import json
from uuid import uuid4

import pytest
from worker_python.tasks import cloud_visuals as task
from worker_python.visual_checkpoints import VisualRun
from worker_python.pipeline.visual_chunks import chunk_key, visual_prefix
from worker_python.pipeline.storage import upload_bytes


@pytest.fixture
def setup(monkeypatch, tmp_path):
    monkeypatch.setenv('USE_S3_STORAGE','false')
    monkeypatch.setenv('MEDIA_ROOT',str(tmp_path))
    run = VisualRun(1,str(uuid4()),'file.mp4',60_000,1,'processing')
    pack = tmp_path/'pack'
    pack.write_bytes(b'pack bytes')
    samples = json.dumps([{'timestamp_seconds':0,'jpeg_base64':'/9j/2Q==','offset':12,'length':4}]).encode()
    return run,pack,samples,tmp_path


def test_chunk_upload_uses_immutable_attempt_keys(setup, monkeypatch):
    run,pack,samples,root=setup
    calls=[]
    def api(action,body):
        if action=='visual/begin-object':
            return {'accepted':True}
        calls.append((action,body))
        return {'current':True,'objectVersion':body['objectVersion']}
    monkeypatch.setattr(task,'call_internal_api',api)
    assert task.publish_chunk(run,0,pack,samples,1)
    version=calls[0][1]['objectVersion']
    assert (root/chunk_key(run.file_key,run.run_id,0,object_version=version)).read_bytes()==b'pack bytes'
    assert not (root/chunk_key(run.file_key,run.run_id,0)).exists()


def test_deleted_or_losing_attempt_removes_only_its_own_objects(setup,monkeypatch):
    run,pack,samples,root=setup
    winner=str(uuid4())
    winner_key=chunk_key(run.file_key,run.run_id,0,object_version=winner)
    upload_bytes(winner_key,b'winner','application/octet-stream')
    monkeypatch.setattr(task,'call_internal_api',lambda action,body:{'accepted':True} if action=='visual/begin-object' else {'current':True,'objectVersion':winner})
    assert task.publish_chunk(run,0,pack,samples,1)
    assert (root/winner_key).read_bytes()==b'winner'
    assert len(list((root/visual_prefix(run.file_key)).rglob('*.bin')))==1


def test_final_manifest_points_to_selected_versions_and_no_legacy_alias(setup,monkeypatch):
    run,pack,samples,root=setup
    version=str(uuid4())
    upload_bytes(chunk_key(run.file_key,run.run_id,0,'json',object_version=version),samples,'application/json')
    def api(action,body):
        if action=='visual/begin-object':
            return {'accepted':True}
        if action=='visual/chunks':
            return {'chunks':[{'index':0,'frameCount':1,'objectVersion':version}]}
        return {'accepted':True,'objectVersion':body.get('objectVersion')}
    monkeypatch.setattr(task,'call_internal_api',api)
    task.finish_run(run)
    manifests=list((root/f'{visual_prefix(run.file_key)}{run.run_id}/publications').glob('*/manifest.json'))
    assert len(manifests)==1
    assert json.loads(manifests[0].read_bytes())['chunk_versions']==[version]
    assert not (root/f'{run.file_key}.focus-v2.json').exists()


def test_deleted_run_cannot_publish_a_manifest(setup,monkeypatch):
    run,pack,samples,root=setup
    version=str(uuid4())
    upload_bytes(chunk_key(run.file_key,run.run_id,0,'json',object_version=version),samples,'application/json')
    def api(action,body):
        if action=='visual/begin-object':
            return {'accepted':True}
        if action=='visual/chunks':
            return {'chunks':[{'index':0,'frameCount':1,'objectVersion':version}]}
        if action=='visual/ready':
            return {'accepted':False}
        return {'run':None}
    monkeypatch.setattr(task,'call_internal_api',api)
    task.finish_run(run)
    assert not list((root/f'{visual_prefix(run.file_key)}{run.run_id}').glob('publications/*/manifest.json'))


def test_failed_second_upload_cleans_unpublished_attempt(setup,monkeypatch):
    run,pack,samples,root=setup
    def fail(*args):
        raise RuntimeError('storage outage')
    monkeypatch.setattr(task,'call_internal_api',lambda *args:{'accepted':True})
    monkeypatch.setattr(task,'upload_bytes',fail)
    with pytest.raises(RuntimeError,match='storage outage'):
        task.publish_chunk(run,0,pack,samples,1)
    assert not list((root/visual_prefix(run.file_key)).rglob('*.bin'))


def test_rejected_registration_never_starts_a_put(setup,monkeypatch):
    run,pack,samples,root=setup
    monkeypatch.setattr(task,'call_internal_api',lambda *args:{'accepted':False})
    assert task.publish_chunk(run,0,pack,samples,1) is False
    assert not (root/visual_prefix(run.file_key)).exists()


def test_expired_manifest_registration_waits_for_recovery_before_put(setup,monkeypatch):
    run,pack,samples,root=setup
    version=str(uuid4())
    upload_bytes(chunk_key(run.file_key,run.run_id,0,'json',object_version=version),samples,'application/json')
    def api(action,body):
        if action=='visual/chunks':
            return {'chunks':[{'index':0,'frameCount':1,'objectVersion':version}]}
        if action=='visual/begin-object':
            return {'accepted':False}
        return {'run':{'status':'processing'}}
    monkeypatch.setattr(task,'call_internal_api',api)
    with pytest.raises(RuntimeError,match='object recovery'):
        task.finish_run(run)
    assert not list((root/f'{visual_prefix(run.file_key)}{run.run_id}').glob('publications/*/manifest.json'))
