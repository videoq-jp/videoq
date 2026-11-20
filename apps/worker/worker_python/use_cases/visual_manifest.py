"""Visual readiness, overview sampling and immutable publication content."""
from dataclasses import dataclass
from typing import Callable
from worker_python.use_cases.visual_publication import VisualChunk


@dataclass(frozen=True)
class VisualManifestPlan:
    video_id: int
    run_id: str
    duration_ms: int
    chunk_count: int


@dataclass(frozen=True)
class VisualManifestDependencies:
    read_samples: Callable[[int, str | None], list[dict]]
    encode_json: Callable[[dict], bytes]
    max_bytes: int
    chunk_seconds: int


def publication_payloads(run: VisualManifestPlan, rows: list[VisualChunk], deps: VisualManifestDependencies, *, versioned=False):
    if len(rows) != run.chunk_count or any(row.frame_count is None for row in rows):
        raise RuntimeError('Visual chunks are incomplete')
    if not sum(row.frame_count for row in rows):
        raise ValueError('No video frames are available')
    frames, overview, versions = [], [], []
    for row in rows:
        version = row.object_version if versioned else None
        if versioned and not version:
            raise RuntimeError('Visual object version is missing')
        versions.append(version)
        samples = deps.read_samples(row.index, version)
        for frame in samples:
            overview.append([round(frame['timestamp_seconds'] * 1000), row.index, frame['offset'], frame['length']])
            frames.append({key: frame[key] for key in ('timestamp_seconds', 'jpeg_base64')})
    if not frames:
        raise ValueError('No overview frames are available')
    duration = run.duration_ms / 1000
    def overview_payload():
        return deps.encode_json({'version': 1, 'video_id': run.video_id, 'duration_seconds': duration,
            'sampling_interval_seconds': max(5, duration / len(frames)), 'frames': frames})
    payload = overview_payload()
    while len(payload) > deps.max_bytes:
        frames = frames[::2]
        payload = overview_payload()
    manifest = {'version': 2, 'video_id': run.video_id, 'run_id': run.run_id,
        'duration_seconds': duration, 'chunk_seconds': deps.chunk_seconds, 'chunk_count': run.chunk_count, 'overview': overview}
    if versioned:
        manifest['chunk_versions'] = versions
    return payload, deps.encode_json(manifest)
