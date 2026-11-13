"""D1 scene ingestion with revision fencing; models/splitting stay shared."""
from __future__ import annotations

import uuid

from worker_python.internal_api import call_internal_api
from worker_python.pipeline.embedding_contract import resolve_embedding_config
from worker_python.pipeline.embeddings import embed_texts
from worker_python.pipeline.scene_otsu import apply_scene_splitting
from worker_python.pipeline.srt import parse_srt_scenes


def reindex_cloud_video(video_id: int, *, finish_indexing: bool = False, allow_empty: bool = False) -> int:
    source = call_internal_api("scene-index/source", {"videoId": video_id}).get("source")
    if source is None:
        return 0  # Deletion wins over a queued reindex.
    if not isinstance(source, dict) or source.get("videoId") != video_id:
        raise RuntimeError("Invalid scene source response")
    transcript = source.get("transcript")
    if not isinstance(transcript, str):
        raise RuntimeError("Invalid scene transcript response")
    completion = {"videoId": video_id, "userId": source["userId"],
                  "sourceRevision": source["sourceRevision"], "fileKey": source.get("fileKey", ""),
                  "dimensions": resolve_embedding_config().dimensions}
    if finish_indexing:
        if source.get("status") == "completed":
            return 0
        if source.get("status") != "indexing":
            raise RuntimeError("Video is not ready for indexing")
        status = call_internal_api("scene-index/finish", completion).get("status")
        if status == "completed":
            return 0
        if status == "pending":
            raise RuntimeError("Scene index delivery is pending; retry")
        if status != "missing":
            raise RuntimeError("Scene source changed before indexing; retry")
        if not transcript.strip() and not allow_empty:
            raise ValueError("Video has no transcript")
    scenes = []
    if transcript.strip():
        if not parse_srt_scenes(transcript):
            raise ValueError("Transcript contains no valid SRT scenes")
        scenes = parse_srt_scenes(apply_scene_splitting(transcript))
        if not scenes:
            raise ValueError("Scene splitting produced no valid SRT scenes")
    run_id = str(uuid.uuid4())
    user_id = source["userId"]
    accepted = call_internal_api("scene-index/start", {
        "runId": run_id, "videoId": video_id, "userId": user_id,
        "sourceRevision": source["sourceRevision"],
        "dimensions": resolve_embedding_config().dimensions, "expectedScenes": len(scenes),
    })
    if accepted.get("accepted") is not True:
        raise RuntimeError("Scene source changed before indexing; retry")
    # Keep every request bounded; the D1 adapter revalidates dimensions and values.
    for offset in range(0, len(scenes), 20):
        chunk = scenes[offset:offset + 20]
        embeddings = embed_texts([scene.text for scene in chunk])
        rows = [{"id": str(uuid.uuid5(uuid.UUID(run_id), str(offset + index))),
                 "content": scene.text, "startTime": scene.start_time,
                 "endTime": scene.end_time, "embedding": embedding}
                for index, (scene, embedding) in enumerate(zip(chunk, embeddings, strict=True))]
        result = call_internal_api("scene-index/stage", {"runId": run_id, "userId": user_id, "scenes": rows})
        if result.get("accepted") is not True:
            raise RuntimeError("Scene source changed during indexing; retry")
    result = call_internal_api("scene-index/publish", {"runId": run_id, "userId": user_id})
    if result.get("accepted") is not True:
        raise RuntimeError("Scene source changed before publication; retry")
    if finish_indexing:
        status = call_internal_api("scene-index/finish", completion).get("status")
        if status != "completed":
            raise RuntimeError("Scene index delivery is pending or source changed; retry")
    return len(scenes)
