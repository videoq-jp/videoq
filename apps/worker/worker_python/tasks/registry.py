"""Task registry: native job type → callable."""

from __future__ import annotations

from collections.abc import Callable
from importlib import import_module

from worker_python.contracts import (
    JOB_DELETE_ACCOUNT_DATA,
    JOB_INDEX_VIDEO_TRANSCRIPT,
    JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS,
    JOB_REINDEX_VIDEO_TRANSCRIPT,
    JOB_TRANSCRIBE_VIDEO,
    JOB_TRANSCRIBE_VIDEO_CHUNK,
    JOB_FINISH_VIDEO_TRANSCRIPTION,
    JOB_BUILD_VIDEO_VISUALS,
    JOB_BUILD_VIDEO_VISUAL_CHUNK,
    JOB_FINISH_VIDEO_VISUALS,
)

TaskFn = Callable[..., None]

TASK_REGISTRY: dict[str, tuple[str, str]] = {
    JOB_TRANSCRIBE_VIDEO: ("transcription", "transcribe_video"),
    JOB_TRANSCRIBE_VIDEO_CHUNK: ("segmented_transcription", "transcribe_video_chunk"),
    JOB_FINISH_VIDEO_TRANSCRIPTION: ("segmented_transcription", "finish_video_transcription"),
    JOB_BUILD_VIDEO_VISUALS: ("segmented_transcription", "build_video_visuals"),
    JOB_BUILD_VIDEO_VISUAL_CHUNK: ("segmented_visuals", "build_video_visual_chunk"),
    JOB_FINISH_VIDEO_VISUALS: ("segmented_visuals", "finish_video_visuals"),
    JOB_DELETE_ACCOUNT_DATA: ("account_deletion", "delete_account_data"),
    JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS: ("reindexing", "reindex_all_videos_embeddings"),
    JOB_INDEX_VIDEO_TRANSCRIPT: ("indexing", "index_video_transcript"),
    JOB_REINDEX_VIDEO_TRANSCRIPT: ("reindex_video_transcript", "reindex_video_transcript"),
}


def get_task(name: str) -> TaskFn:
    try:
        module, function = TASK_REGISTRY[name]
    except KeyError as exc:
        raise KeyError(f"Task not registered: {name}") from exc

    # Import only the selected task: media dependency failures must not prevent
    # account/search consumers from starting. The deployment image stays shared.
    return getattr(import_module(f"worker_python.tasks.{module}"), function)
