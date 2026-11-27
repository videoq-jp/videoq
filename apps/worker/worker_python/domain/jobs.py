"""Pure job identities, payload invariants and workload grouping."""

import json
from typing import Any, Callable, TypeVar
from uuid import UUID, NAMESPACE_URL, uuid5

JOB_TRANSCRIBE_VIDEO = "transcribe_video"
JOB_DELETE_ACCOUNT_DATA = "delete_account_data"
JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS = "reindex_all_videos_embeddings"
JOB_INDEX_VIDEO_TRANSCRIPT = "index_video_transcript"
JOB_REINDEX_VIDEO_TRANSCRIPT = "reindex_video_transcript"
JOB_TRANSCRIBE_VIDEO_CHUNK = "transcribe_video_chunk"
JOB_FINISH_VIDEO_TRANSCRIPTION = "finish_video_transcription"
JOB_PREPARE_VIDEO_VISUALS = "prepare_video_visuals"
JOB_BUILD_VIDEO_VISUALS = "build_video_visuals"
JOB_BUILD_VIDEO_VISUAL_CHUNK = "build_video_visual_chunk"
JOB_FINISH_VIDEO_VISUALS = "finish_video_visuals"

_PAYLOAD_FIELDS = {
    JOB_TRANSCRIBE_VIDEO: "video_id",
    JOB_PREPARE_VIDEO_VISUALS: "video_id",
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

# ECMAScript String.trim, not Python str.strip (which also strips U+0085).
_WIRE_WHITESPACE = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def _wire_string(value: object, maximum: int, *, nonblank: bool = False) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        length = len(value.encode('utf-16-le')) // 2
    except UnicodeEncodeError:
        return False
    return length <= maximum and (not nonblank or bool(value.strip(_WIRE_WHITESPACE)))


def parse_job_message(message: object) -> dict[str, Any]:
    """Validate the wire envelope and normalize JSON safe integers before hashing.

    JSON's 42, 42.0 and 4.2e1 have one identity in JavaScript. Native task
    arguments stay strict; normalization happens only at this wire boundary.
    """
    if not isinstance(message, dict):
        raise ValueError('Job message must be an object')
    if set(message) != {'type', 'job_id', 'payload'}:
        raise ValueError('Job message must contain exactly type, job_id and payload')
    kind, job_id, payload = message['type'], message['job_id'], message['payload']
    if not _wire_string(kind, 64):
        raise ValueError('type must be a non-empty string of at most 64 UTF-16 units')
    if not _wire_string(job_id, 128):
        raise ValueError('job_id must be a non-empty string of at most 128 UTF-16 units')
    if not isinstance(payload, dict):
        raise ValueError('payload must be an object')
    body = dict(payload)
    # Preserve explicit retirement acknowledgement for queued historical jobs.
    if kind not in {'build_plog', 'evaluate_chat_log'}:
        for field in ('video_id', 'after_id', 'chunk_index'):
            value = body.get(field)
            if type(value) is float and value.is_integer() and abs(value) <= 2**53 - 1:
                body[field] = int(value)
        validate_job_payload(kind, body)
    return {'type': kind, 'job_id': job_id, 'payload': body}


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
        if "root_job_id" in expected and not _wire_string(payload["root_job_id"], 128, nonblank=True):
            raise ValueError("root_job_id must be a non-empty string of at most 128 characters")
        return
    if "allow_empty" in expected and type(payload["allow_empty"]) is not bool:
        raise ValueError("allow_empty must be a boolean")
    value = payload[field]
    if field == "user_id":
        if not _wire_string(value, 128, nonblank=True):
            raise ValueError("user_id must be a non-empty string of at most 128 UTF-16 units")
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


def job_group(job_type: str) -> str:
    if job_type == JOB_DELETE_ACCOUNT_DATA:
        return "account"
    if job_type in {
        JOB_INDEX_VIDEO_TRANSCRIPT, JOB_REINDEX_VIDEO_TRANSCRIPT,
        JOB_REINDEX_ALL_VIDEOS_EMBEDDINGS,
    }:
        return "search"
    return "media"



def build_job_message(
    job_type: str, payload: dict[str, Any] | None = None,
    *, job_id: str | None = None, new_id: Callable[[], str],
) -> dict[str, Any]:
    body = {} if payload is None else payload
    validate_job_payload(job_type, body)
    return {"type": job_type, "job_id": job_id or new_id(), "payload": body}


def child_job_id(parent_job_id: str, job_type: str, payload: dict[str, Any] | None = None) -> str:
    """Canonical identity makes parent retries reuse the same stage-scoped child."""
    canonical = json.dumps(
        {"parent_job_id": parent_job_id, "type": job_type, "payload": payload or {}},
        sort_keys=True, separators=(",", ":"),
    )
    return str(uuid5(NAMESPACE_URL, f"videoq:{canonical}"))


def job_claim_decision(same_identity: bool, status: str, lease_active: bool) -> str:
    if not same_identity:
        return 'conflict'
    if status == 'completed':
        return 'completed'
    return 'busy' if status == 'running' and lease_active else 'claimable'


LeaseTerm = TypeVar('LeaseTerm')


def job_lease_mutation_allowed(operation: str, running: LeaseTerm, token_matches: LeaseTerm, lease_active: LeaseTerm,
                               conjunction: Callable[..., LeaseTerm]) -> LeaseTerm:
    return conjunction(running, token_matches, *([lease_active] if operation == 'heartbeat' else []))
