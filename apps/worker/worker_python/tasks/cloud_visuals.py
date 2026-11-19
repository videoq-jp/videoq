"""D1 and object storage adapters for immutable visual publication."""
from uuid import uuid4
from worker_python.internal_api import call_internal_api
from worker_python.pipeline.storage import upload_file, upload_bytes, delete_object
from worker_python.pipeline.visual_chunks import chunk_key, visual_prefix
from worker_python.pipeline.visual_publication import publication_payloads
from worker_python.use_cases.visual_publication import (
    PublicationResult, VisualChunk, VisualPublicationDependencies,
    publish_chunk as execute_publish_chunk, finish_run as execute_finish_run,
)


def _dependencies(run):
    def call(action, **values):
        return call_internal_api(action, {'videoId': run.video_id, 'runId': run.run_id, **values})

    def register(version, index):
        values = {'objectVersion': version}
        if index is not None:
            values['index'] = index
        return call('visual/begin-object', **values).get('accepted') is True

    def publish(index, count, version):
        result = call('visual/publish', index=index, frameCount=count, objectVersion=version)
        return PublicationResult(result.get('current') is True, result.get('objectVersion'))

    def chunks():
        rows = call('visual/chunks').get('chunks')
        if rows is None:
            return None
        return [VisualChunk(row['index'], row['frameCount'], row['objectVersion']) for row in rows]

    def prepare_manifest(rows):
        return publication_payloads(run, [
            {'chunk_index': row.index, 'frame_count': row.frame_count, 'object_version': row.object_version}
            for row in rows
        ], versioned=True)

    def manifest_keys(version):
        prefix = f'{visual_prefix(run.file_key)}{run.run_id}/publications/{version}/'
        return prefix + 'overview.json', prefix + 'manifest.json'

    def ready(version):
        result = call('visual/ready', objectVersion=version)
        return PublicationResult(result.get('accepted') is True, result.get('objectVersion'))

    def load_status():
        current = call('visual/load').get('run')
        return current.get('status') if current is not None else None

    return VisualPublicationDependencies(
        new_version=lambda: str(uuid4()), register=register,
        chunk_keys=lambda index, version: (
            chunk_key(run.file_key, run.run_id, index, object_version=version),
            chunk_key(run.file_key, run.run_id, index, 'json', object_version=version),
        ),
        manifest_keys=manifest_keys,
        upload_pack=lambda key, pack: upload_file(key, pack, 'application/octet-stream'),
        upload_json=lambda key, data: upload_bytes(key, data, 'application/json'),
        delete=delete_object, publish_chunk=publish, chunks=chunks,
        prepare_manifest=prepare_manifest, publish_manifest=ready, load_status=load_status,
    )


def publish_chunk(run, index, pack, sparse, count):
    return execute_publish_chunk(index, pack, sparse, count, _dependencies(run))


def finish_run(run):
    execute_finish_run(_dependencies(run))
