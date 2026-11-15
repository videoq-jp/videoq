"""Cloud transcription persistence through signed business operations."""
from worker_python.env import env_str, heavy_pipeline_enabled
from worker_python.internal_api import call_internal_api
from worker_python.pipeline.transcription import run_transcription
from worker_python.pipeline.user_secret_envelope import try_decrypt
from worker_python.processing_quota import reserve_video_processing
from worker_python.video_sql import VideoRow


def transcribe_cloud_video(video_id: int) -> None:
    from worker_python.tasks.transcription import (
        ProcessingQuotaExceededError, TranscriptionExecutionFailedError,
    )
    source = call_internal_api("transcription/source", {"videoId": video_id}).get("source")
    if source is None:
        return
    if not isinstance(source, dict) or source.get("videoId") != video_id:
        raise RuntimeError("Invalid transcription source response")
    status = source.get("status")
    if status in {"indexing", "completed"}:
        # The successful save already registered the indexing outbox atomically.
        return
    if status not in {"pending", "processing", "error"}:
        raise TranscriptionExecutionFailedError("Video is not ready for transcription")
    snapshot = {key: source[key] for key in ("videoId", "userId", "sourceRevision", "fileKey")}
    video = VideoRow(id=video_id, user_id=source["userId"], title=source["title"], transcript=None,
                     status=str(status), source_type=source["sourceType"], file_key=source["fileKey"] or None,
                     youtube_video_id=source["youtubeVideoId"] or None, transcript_hash=source["sourceRevision"],
                     transcription_language=source.get("transcriptionLanguage"))
    if source["sourceType"] == "uploaded" and heavy_pipeline_enabled():
        from worker_python.tasks.segmented_transcription import start_uploaded_transcription
        from worker_python.transcription_checkpoints import TranscriptionQuotaError
        try:
            start_uploaded_transcription(video)
        except TranscriptionQuotaError:
            if call_internal_api("transcription/begin", {**snapshot, "expectedStatus": status}).get("accepted") is True:
                call_internal_api("transcription/finish", {**snapshot, "transcript": None, "errorCode": "PROCESSING_QUOTA_EXCEEDED"})
        return
    if call_internal_api("transcription/begin", {**snapshot, "expectedStatus": status}).get("accepted") is not True:
        raise TranscriptionExecutionFailedError("Transcription source changed before processing; retry")
    transcript = None
    error_code = None
    try:
        searchapi_key = None
        if video.source_type == "youtube":
            searchapi_key = env_str("SEARCHAPI_API_KEY") or try_decrypt(source.get("searchapiKeyEncrypted"))

        def reserve(seconds: int) -> None:
            if not reserve_video_processing(video_id, seconds).allowed:
                raise ProcessingQuotaExceededError("Processing quota exceeded")

        transcript = run_transcription(video, searchapi_key=searchapi_key, reserve_processing=reserve)
    except ProcessingQuotaExceededError:
        error_code = "PROCESSING_QUOTA_EXCEEDED"
    except Exception:
        error_code = "TRANSCRIPTION_FAILED"
    result = call_internal_api("transcription/finish", {
        **snapshot, "transcript": transcript, "errorCode": error_code,
    })
    if result.get("status") == "error" and error_code == "TRANSCRIPTION_FAILED":
        raise TranscriptionExecutionFailedError("Cloud transcription failed; retry")
