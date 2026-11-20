"""D1 scene ingestion adapters; indexing decisions live in the use case."""
from __future__ import annotations

import uuid

from worker_python.internal_api import call_internal_api
from worker_python.pipeline.embedding_contract import resolve_embedding_config
from worker_python.pipeline.embeddings import embed_texts
from worker_python.pipeline.scene_otsu import apply_scene_splitting
from worker_python.use_cases.scene_index import SceneSource, SceneIndexDependencies, execute_scene_index


def reindex_cloud_video(video_id: int, *, finish_indexing: bool = False, allow_empty: bool = False) -> int:
    def load(identifier):
        source = call_internal_api("scene-index/source", {"videoId": identifier}).get("source")
        if source is None:
            return None
        if not isinstance(source, dict) or source.get("videoId") != identifier:
            raise RuntimeError("Invalid scene source response")
        transcript = source.get("transcript")
        if not isinstance(transcript, str):
            raise RuntimeError("Invalid scene transcript response")
        return SceneSource(identifier, source["userId"], source["sourceRevision"], source.get("fileKey", ""), transcript, source.get("status"))

    def finish(source):
        return call_internal_api("scene-index/finish", {
            "videoId": source.video_id, "userId": source.user_id,
            "sourceRevision": source.revision, "fileKey": source.file_key,
            "dimensions": resolve_embedding_config().dimensions,
        }).get("status")

    def start(source, run_id, count):
        return call_internal_api("scene-index/start", {
            "runId": run_id, "videoId": source.video_id, "userId": source.user_id,
            "sourceRevision": source.revision, "dimensions": resolve_embedding_config().dimensions,
            "expectedScenes": count,
        }).get("accepted") is True

    def stage(run_id, user_id, rows):
        return call_internal_api("scene-index/stage", {
            "runId": run_id, "userId": user_id,
            "scenes": [{"id": row.id, "content": row.content, "startTime": row.start_time,
                        "endTime": row.end_time, "embedding": row.embedding} for row in rows],
        }).get("accepted") is True

    return execute_scene_index(video_id, SceneIndexDependencies(
        load=load, finish=finish, split=apply_scene_splitting,
        new_run_id=lambda: str(uuid.uuid4()),
        scene_id=lambda run_id, index: str(uuid.uuid5(uuid.UUID(run_id), str(index))),
        start=start, embed=embed_texts, stage=stage,
        publish=lambda run_id, user_id: call_internal_api("scene-index/publish", {"runId": run_id, "userId": user_id}).get("accepted") is True,
    ), finish_indexing=finish_indexing, allow_empty=allow_empty)
