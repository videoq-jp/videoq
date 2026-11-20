"""Object-storage and JSON adapters for visual manifest assembly."""
import json
from worker_python.pipeline.storage import read_bytes
from worker_python.pipeline.visual_chunks import chunk_key, CHUNK_SECONDS
from worker_python.pipeline.visual_frames import MAX_CACHE_BYTES
from worker_python.use_cases.visual_publication import VisualChunk
from worker_python.use_cases.visual_manifest import (
    VisualManifestDependencies, VisualManifestPlan, publication_payloads as assemble_publication,
)


def publication_payloads(run, rows, *, versioned=False):
    return assemble_publication(
        VisualManifestPlan(run.video_id, run.run_id, run.duration_ms, run.chunk_count),
        [VisualChunk(row['chunk_index'], row['frame_count'], row.get('object_version')) for row in rows],
        VisualManifestDependencies(
            read_samples=lambda index, version: json.loads(read_bytes(
                chunk_key(run.file_key, run.run_id, index, 'json', object_version=version), MAX_CACHE_BYTES)),
            encode_json=lambda value: json.dumps(value, separators=(',', ':')).encode(),
            max_bytes=MAX_CACHE_BYTES, chunk_seconds=CHUNK_SECONDS,
        ),
        versioned=versioned,
    )
