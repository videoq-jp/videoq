"""VideoQ API と worker が共有する SQS job type contracts."""

from uuid import UUID

JOB_TRANSCRIBE_VIDEO = "transcribe_video"
JOB_DELETE_ACCOUNT_DATA = "delete_account_data"
JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS = "reindex_all_videos_embeddings"
JOB_INDEX_VIDEO_TRANSCRIPT = "index_video_transcript"
JOB_REINDEX_VIDEO_TRANSCRIPT = "reindex_video_transcript"
JOB_TRANSCRIBE_VIDEO_CHUNK = "transcribe_video_chunk"
JOB_FINISH_VIDEO_TRANSCRIPTION = "finish_video_transcription"
JOB_BUILD_VIDEO_VISUALS = "build_video_visuals"
JOB_BUILD_VIDEO_VISUAL_CHUNK = "build_video_visual_chunk"
JOB_FINISH_VIDEO_VISUALS = "finish_video_visuals"

_PAYLOAD_FIELDS = {
    JOB_TRANSCRIBE_VIDEO: "video_id",
    JOB_INDEX_VIDEO_TRANSCRIPT: "video_id",
    JOB_REINDEX_VIDEO_TRANSCRIPT: "video_id",
    JOB_DELETE_ACCOUNT_DATA: "user_id",
    JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS: None,
    JOB_TRANSCRIBE_VIDEO_CHUNK: "video_id",
    JOB_FINISH_VIDEO_TRANSCRIPTION: "video_id",
    JOB_BUILD_VIDEO_VISUALS: "video_id",
    JOB_BUILD_VIDEO_VISUAL_CHUNK: "video_id",
    JOB_FINISH_VIDEO_VISUALS: "video_id",
}


def validate_job_payload(job_type: str, payload: dict) -> None:
    """Validate native task arguments without coercing one resource ID to another."""
    if job_type not in _PAYLOAD_FIELDS:
        raise ValueError(f"Unsupported job type: {job_type}")
    field = _PAYLOAD_FIELDS[job_type]
    expected = {field} if field else set()
    if job_type == JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS and isinstance(payload, dict) and "after_id" in payload:
        expected.add("after_id")
        if "root_job_id" in payload:
            expected.add("root_job_id")
    if job_type in {JOB_TRANSCRIBE_VIDEO_CHUNK, JOB_FINISH_VIDEO_TRANSCRIPTION, JOB_BUILD_VIDEO_VISUALS, JOB_BUILD_VIDEO_VISUAL_CHUNK, JOB_FINISH_VIDEO_VISUALS}:
        expected.add("run_id")
    if job_type in {JOB_TRANSCRIBE_VIDEO_CHUNK, JOB_BUILD_VIDEO_VISUAL_CHUNK}:
        expected.add("chunk_index")
    if job_type == JOB_BUILD_VIDEO_VISUALS:
        expected.add("cache_kind")
    if job_type == JOB_INDEX_VIDEO_TRANSCRIPT and isinstance(payload, dict) and "allow_empty" in payload:
        expected.add("allow_empty")
    if not isinstance(payload, dict) or set(payload) != expected:
        raise TypeError(f"{job_type} payload must contain exactly {sorted(expected)}")
    if field is None:
        if "after_id" in expected and (type(payload["after_id"]) is not int or not 0 <= payload["after_id"] <= 2**53 - 1):
            raise ValueError("after_id must be a non-negative safe integer")
        if "root_job_id" in expected and (not isinstance(payload["root_job_id"], str) or not payload["root_job_id"].strip() or len(payload["root_job_id"]) > 128):
            raise ValueError("root_job_id must be a non-empty string of at most 128 characters")
        return
    if "allow_empty" in expected and type(payload["allow_empty"]) is not bool:
        raise ValueError("allow_empty must be a boolean")
    value = payload[field]
    if field == "user_id":
        if not isinstance(value, str) or not value.strip():
            raise ValueError("user_id must be a non-empty string")
    elif type(value) is not int or not 0 < value <= 2**53 - 1:
        # Match the API's positive safe integer IDs. bool is an int subclass;
        # int(float/string/bool) would silently change the queued operation.
        raise ValueError(f"{field} must be a positive safe integer")
    if "run_id" in expected:
        run_id = payload["run_id"]
        if not isinstance(run_id, str):
            raise ValueError("run_id must be a UUID")
        try:
            if str(UUID(run_id)) != run_id:
                raise ValueError()
        except ValueError:
            raise ValueError("run_id must be a canonical UUID") from None
    if "chunk_index" in expected:
        index = payload["chunk_index"]
        if type(index) is not int or not 0 <= index < 10000:
            raise ValueError("chunk_index must be an integer between 0 and 9999")
    if "cache_kind" in expected and payload["cache_kind"] not in {"coarse", "focus"}:
        raise ValueError("cache_kind must be coarse or focus")
