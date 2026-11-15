"""Shared manifest/overview generation for PostgreSQL and D1 visual runs."""
import json
from worker_python.pipeline.storage import read_bytes
from worker_python.pipeline.visual_chunks import chunk_key, CHUNK_SECONDS
from worker_python.pipeline.visual_frames import MAX_CACHE_BYTES


def publication_payloads(run, rows, *, versioned=False):
    if len(rows) != run.chunk_count or any(row['frame_count'] is None for row in rows):
        raise RuntimeError('Visual chunks are incomplete')
    if not sum(row['frame_count'] for row in rows):
        raise ValueError('No video frames are available')
    frames, overview, versions = [], [], []
    for row in rows:
        version = row.get('object_version') if versioned else None
        if versioned and not version:
            raise RuntimeError('Visual object version is missing')
        versions.append(version)
        samples = json.loads(read_bytes(chunk_key(run.file_key, run.run_id, row['chunk_index'], 'json', object_version=version), MAX_CACHE_BYTES))
        for frame in samples:
            overview.append([round(frame['timestamp_seconds'] * 1000), row['chunk_index'], frame['offset'], frame['length']])
            frames.append({key: frame[key] for key in ('timestamp_seconds', 'jpeg_base64')})
    if not frames:
        raise ValueError('No overview frames are available')
    duration = run.duration_ms / 1000
    def overview_payload():
        return json.dumps({'version': 1, 'video_id': run.video_id, 'duration_seconds': duration,
            'sampling_interval_seconds': max(5, duration / len(frames)), 'frames': frames}, separators=(',', ':')).encode()
    payload = overview_payload()
    while len(payload) > MAX_CACHE_BYTES:
        frames = frames[::2]
        payload = overview_payload()
    manifest = {'version': 2, 'video_id': run.video_id, 'run_id': run.run_id,
        'duration_seconds': duration, 'chunk_seconds': CHUNK_SECONDS, 'chunk_count': run.chunk_count, 'overview': overview}
    if versioned:
        manifest['chunk_versions'] = versions
    return payload, json.dumps(manifest, separators=(',', ':')).encode()
