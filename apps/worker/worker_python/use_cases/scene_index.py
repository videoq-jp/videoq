"""Revision-fenced scene indexing lifecycle; adapters own transport and models."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from worker_python.domain.srt import parse_srt_scenes


@dataclass(frozen=True)
class SceneSource:
    video_id: int
    user_id: str
    revision: str
    file_key: str
    transcript: str
    status: str | None


@dataclass(frozen=True)
class SceneRow:
    id: str
    content: str
    start_time: str
    end_time: str
    embedding: list[float]


@dataclass(frozen=True)
class SceneIndexDependencies:
    load: Callable[[int], SceneSource | None]
    finish: Callable[[SceneSource], str | None]
    split: Callable[[str], str]
    new_run_id: Callable[[], str]
    scene_id: Callable[[str, int], str]
    start: Callable[[SceneSource, str, int], bool]
    embed: Callable[[list[str]], list[list[float]]]
    stage: Callable[[str, str, list[SceneRow]], bool]
    publish: Callable[[str, str], bool]


def execute_scene_index(video_id: int, deps: SceneIndexDependencies, *, finish_indexing: bool = False, allow_empty: bool = False) -> int:
    source = deps.load(video_id)
    if source is None:
        return 0
    transcript = source.transcript
    if finish_indexing:
        if source.status == 'completed':
            return 0
        if source.status != 'indexing':
            raise RuntimeError('Video is not ready for indexing')
        status = deps.finish(source)
        if status == 'completed':
            return 0
        if status == 'pending':
            raise RuntimeError('Scene index delivery is pending; retry')
        if status != 'missing':
            raise RuntimeError('Scene source changed before indexing; retry')
        if not transcript.strip() and not allow_empty:
            raise ValueError('Video has no transcript')
    scenes = []
    if transcript.strip():
        if not parse_srt_scenes(transcript):
            raise ValueError('Transcript contains no valid SRT scenes')
        scenes = parse_srt_scenes(deps.split(transcript))
        if not scenes:
            raise ValueError('Scene splitting produced no valid SRT scenes')
    run_id = deps.new_run_id()
    if deps.start(source, run_id, len(scenes)) is not True:
        raise RuntimeError('Scene source changed before indexing; retry')
    for offset in range(0, len(scenes), 20):
        chunk = scenes[offset:offset + 20]
        embeddings = deps.embed([scene.text for scene in chunk])
        rows = [SceneRow(deps.scene_id(run_id, offset + index), scene.text, scene.start_time, scene.end_time, embedding)
                for index, (scene, embedding) in enumerate(zip(chunk, embeddings, strict=True))]
        if deps.stage(run_id, source.user_id, rows) is not True:
            raise RuntimeError('Scene source changed during indexing; retry')
    if deps.publish(run_id, source.user_id) is not True:
        raise RuntimeError('Scene source changed before publication; retry')
    if finish_indexing and deps.finish(source) != 'completed':
        raise RuntimeError('Scene index delivery is pending or source changed; retry')
    return len(scenes)
