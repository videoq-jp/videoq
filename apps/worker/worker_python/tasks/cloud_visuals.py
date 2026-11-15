"""Immutable object versions with conditional D1 publication after uploads."""
from uuid import uuid4
from worker_python.internal_api import call_internal_api
from worker_python.pipeline.storage import upload_file, upload_bytes, delete_object
from worker_python.pipeline.visual_chunks import chunk_key, visual_prefix
from worker_python.pipeline.visual_publication import publication_payloads


def publish_chunk(run, index, pack, sparse, count):
    version = str(uuid4())
    registration = call_internal_api('visual/begin-object', {'videoId':run.video_id,'runId':run.run_id,'index':index,'objectVersion':version})
    if registration.get('accepted') is not True:
        return False
    binary_key = chunk_key(run.file_key, run.run_id, index, object_version=version)
    json_key = chunk_key(run.file_key, run.run_id, index, 'json', object_version=version)
    try:
        upload_file(binary_key, pack, 'application/octet-stream')
        upload_bytes(json_key, sparse, 'application/json')
    except Exception:
        for key in (binary_key, json_key):
            try:
                delete_object(key)
            except Exception:
                pass  # A storage outage can also defer orphan cleanup.
        raise
    result = call_internal_api('visual/publish', {'videoId':run.video_id,'runId':run.run_id,
        'index':index,'frameCount':count,'objectVersion':version})
    if not result.get('current') or result.get('objectVersion') != version:
        # These names belong solely to this attempt; deleting a loser cannot
        # remove another delivery's published frame pack.
        delete_object(binary_key)
        delete_object(json_key)
    return result.get('current') is True


def finish_run(run):
    response = call_internal_api('visual/chunks', {'videoId':run.video_id,'runId':run.run_id})
    if response.get('chunks') is None:
        return
    rows = [{'chunk_index':row['index'],'frame_count':row['frameCount'],'object_version':row['objectVersion']}
            for row in response['chunks']]
    payload, manifest = publication_payloads(run, rows, versioned=True)
    version = str(uuid4())
    prefix = f'{visual_prefix(run.file_key)}{run.run_id}/publications/{version}/'
    overview_key, manifest_key = prefix+'overview.json', prefix+'manifest.json'
    registration = call_internal_api('visual/begin-object', {'videoId':run.video_id,'runId':run.run_id,'objectVersion':version})
    if registration.get('accepted') is not True:
        current = call_internal_api('visual/load', {'videoId':run.video_id,'runId':run.run_id}).get('run')
        if current and current.get('status') != 'ready':
            raise RuntimeError('Visual publication is waiting for object recovery; retry')
        return
    upload_bytes(overview_key, payload, 'application/json')
    upload_bytes(manifest_key, manifest, 'application/json')
    result = call_internal_api('visual/ready', {'videoId':run.video_id,'runId':run.run_id,'objectVersion':version})
    if result.get('accepted') is not True or result.get('objectVersion') != version:
        delete_object(overview_key)
        delete_object(manifest_key)
        if result.get('accepted') is True:
            return  # Another immutable publication won.
        # Missing current run means deletion/source replacement won the race.
        # Pending current state instead is retryable and cannot become visible.
        current = call_internal_api('visual/load', {'videoId':run.video_id,'runId':run.run_id}).get('run')
        if current is not None:
            raise RuntimeError('Visual publication did not complete; retry')
