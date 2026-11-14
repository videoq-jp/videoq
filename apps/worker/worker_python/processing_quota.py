"""Business operation shared by cloud HTTP and on-prem PostgreSQL workers."""
from worker_python.db import db_connection
from worker_python.internal_api import call_internal_api, uses_internal_persistence
from worker_python.video_sql import ProcessingReservationResult, reserve_processing_seconds


def reserve_video_processing(video_id: int, seconds: int) -> ProcessingReservationResult:
    if uses_internal_persistence():
        result = call_internal_api("processing/reserve", {"videoId": video_id, "seconds": seconds})
        allowed = result.get("allowed")
        limit = result.get("limitSeconds")
        if not isinstance(allowed, bool) or (limit is not None and (type(limit) is not int or limit < 0)):
            raise RuntimeError("Invalid processing quota response")
        return ProcessingReservationResult(allowed=allowed, limit_seconds=limit)
    with db_connection() as conn:
        return reserve_processing_seconds(conn, video_id, seconds)
