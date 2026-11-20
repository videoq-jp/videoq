"""Cloud transcription persistence through signed business operations."""
from contextlib import nullcontext

from worker_python.use_cases.segmented_transcription_start import QuotaRecovery, start_segmented_transcription
from worker_python.env import env_str, heavy_pipeline_enabled
from worker_python.internal_api import call_internal_api
from worker_python.pipeline.transcription import run_transcription
from worker_python.pipeline.user_secret_envelope import try_decrypt
from worker_python.processing_quota import reserve_video_processing
from worker_python.video_sql import VideoRow


from worker_python.use_cases.cloud_transcription import (
    CloudTranscriptionDependencies, execute_cloud_transcription,
)
from worker_python.use_cases.transcription import ProcessingQuotaExceededError


def transcribe_cloud_video(video_id: int) -> None:
    source = None

    def load(identifier):
        nonlocal source
        source = call_internal_api("transcription/source", {"videoId": identifier}).get("source")
        if source is not None and (not isinstance(source, dict) or source.get("videoId") != identifier):
            raise RuntimeError("Invalid transcription source response")
        return source

    def prepare(value):
        # Decode only after the lifecycle has rejected terminal/unready sources.
        return VideoRow(id=video_id, user_id=value["userId"], title=value["title"], transcript=None,
                        status=str(value.get("status")), source_type=value["sourceType"], file_key=value["fileKey"] or None,
                        youtube_video_id=value["youtubeVideoId"] or None, transcript_hash=value["sourceRevision"],
                        transcription_language=value.get("transcriptionLanguage"))

    def snapshot(video):
        return {"videoId": video.id, "userId": video.user_id,
                "sourceRevision": video.transcript_hash, "fileKey": source["fileKey"]}

    def begin(video):
        return call_internal_api("transcription/begin", {**snapshot(video), "expectedStatus": video.status}).get("accepted") is True

    def finish(video, transcript, error_code):
        return call_internal_api("transcription/finish", {
            **snapshot(video), "transcript": transcript, "errorCode": error_code,
        }).get("status")

    def start_segmented(video):
        from worker_python.tasks.segmented_transcription import start_uploaded_transcription
        start_segmented_transcription(
            lambda: start_uploaded_transcription(video),
            lambda: nullcontext(QuotaRecovery(
                begin=lambda: begin(video),
                finish=lambda _message: finish(video, None, "PROCESSING_QUOTA_EXCEEDED"),
            )),
        )

    def transcribe(video):
        searchapi_key = None
        if video.source_type == "youtube":
            searchapi_key = env_str("SEARCHAPI_API_KEY") or try_decrypt(source.get("searchapiKeyEncrypted"))

        def reserve(seconds: int) -> None:
            if not reserve_video_processing(video_id, seconds).allowed:
                raise ProcessingQuotaExceededError("Processing quota exceeded")

        return run_transcription(video, searchapi_key=searchapi_key, reserve_processing=reserve)

    execute_cloud_transcription(video_id, CloudTranscriptionDependencies(
        load=load, status=lambda value: value.get("status"), prepare=prepare,
        is_uploaded=lambda video: video.source_type == "uploaded", start_segmented=start_segmented,
        begin=begin, transcribe=transcribe, finish=finish, segmented_enabled=heavy_pipeline_enabled(),
    ))
