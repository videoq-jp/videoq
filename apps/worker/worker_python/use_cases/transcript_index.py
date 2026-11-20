"""Prepare searchable scenes before atomically replacing their stored snapshot."""
from dataclasses import dataclass
from typing import Callable

from worker_python.domain.srt import SrtScene, parse_srt_scenes


SceneReplacement = Callable[[list[SrtScene], list[list[float]]], int]


@dataclass(frozen=True)
class TranscriptIndexDependencies:
    # Validate storage configuration now; the returned writer opens its atomic
    # operation only when all provider work has finished.
    prepare_replacement: Callable[[], SceneReplacement]
    split: Callable[[str], str]
    embed: Callable[[list[str]], list[list[float]]]


def execute_transcript_index(video_id: int, transcript: str | None, deps: TranscriptIndexDependencies) -> int:
    if not transcript:
        raise ValueError(f"Video {video_id} has no transcript")
    if not parse_srt_scenes(transcript):
        raise ValueError(f"Video {video_id} transcript contains no valid SRT scenes")
    replace = deps.prepare_replacement()
    # Only the search representation is grouped. Persistence retains and
    # compares the original subtitle snapshot, including its cue boundaries.
    scenes = parse_srt_scenes(deps.split(transcript))
    if not scenes:
        raise ValueError(f"Video {video_id} scene splitting produced no valid SRT scenes")
    embeddings = deps.embed([scene.text for scene in scenes])
    return replace(scenes, embeddings)
