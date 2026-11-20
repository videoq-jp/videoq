"""Bounded representative-frame cache, without a model call or new dependencies.

The single JSON sidecar makes publication atomic and cleanup deterministic. It is
private media, not an embedding index. Keep limits/schema in sync with the API.
"""

from __future__ import annotations

import base64
import json
import math
import tempfile
from pathlib import Path

from worker_python.domain.visual_checkpoints import visual_source_eligible
from worker_python.db import db_connection
from worker_python.pipeline.media_process import media_input_args, run_media_process, media_failure
from worker_python.pipeline.storage import ObjectMediaSource, upload_bytes

MAX_FRAMES = 240
MAX_IMAGE_BYTES = 256 * 1024
MAX_CACHE_BYTES = 16 * 1024 * 1024


def frame_cache_key(file_key: str) -> str:
    return f"{file_key}.frames-v1.json"


def build_frame_cache(video_path: Path | ObjectMediaSource, video_id: int, duration: float) -> bytes:
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("Frame cache requires a finite positive duration")
    interval = max(5.0, duration / MAX_FRAMES)
    with tempfile.TemporaryDirectory(prefix="videoq-frames-") as tmp:
        # PTS in filenames comes from actual selected frames, not invented FPS.
        # FFmpeg normalizes the container start time by default. Do not reset
        # the video stream independently: audio can start before the first frame.
        filters = (
            f"select='isnan(prev_selected_t)+gte(t-prev_selected_t,{interval:.6f})',"
            "scale=1024:1024:force_original_aspect_ratio=decrease:force_divisible_by=2,"
            "settb=1/1000"
        )
        result = run_media_process([
            "ffmpeg", "-nostdin", "-v", "error", "-y", *media_input_args(video_path),
            "-map", "0:v:0", "-an", "-vf", filters,
            "-fps_mode", "vfr", "-enc_time_base", "1:1000", "-frame_pts", "1",
            # Auto frame threading can exceed RLIMIT_AS on high-core Docker
            # hosts before the MJPEG encoder emits its first image.
            "-threads:v", "1", "-frames:v", str(MAX_FRAMES), "-q:v", "8", str(Path(tmp) / "%012d.jpg"),
        ])
        if result.returncode:
            raise RuntimeError(media_failure("Frame extraction", result))
        frames = []
        encoded_size = 0
        for path in sorted(Path(tmp).glob("*.jpg"), key=lambda p: int(p.stem)):
            timestamp = int(path.stem) / 1000
            if not 0 <= timestamp <= duration:
                raise ValueError("Invalid frame timestamp")
            if not 0 < path.stat().st_size <= MAX_IMAGE_BYTES:
                raise ValueError("Frame exceeds image size limit")
            image = path.read_bytes()
            if not image.startswith(b"\xff\xd8\xff"):
                raise ValueError("Frame is not a JPEG")
            encoded = base64.b64encode(image).decode("ascii")
            encoded_size += len(encoded)
            if encoded_size > MAX_CACHE_BYTES:
                raise ValueError("Frames exceed cache size limit")
            frames.append({"timestamp_seconds": timestamp, "jpeg_base64": encoded})
        if not frames:
            raise ValueError("No video frames available")
        payload = json.dumps({
            "version": 1, "video_id": video_id, "duration_seconds": duration,
            "sampling_interval_seconds": interval, "frames": frames,
        }, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_CACHE_BYTES:
            raise ValueError("Frame cache exceeds size limit")
        return payload


def publish_frame_cache(video_id: int, file_key: str, payload: bytes) -> bool:
    # Serialize publication with video/account deletion. Extract outside the DB
    # transaction; hold the row lock only for one bounded, atomic object PUT.
    with db_connection() as conn:
        row = conn.execute(
            "SELECT file, source_type FROM videos WHERE id = %s FOR UPDATE", (video_id,),
        ).fetchone()
        if not row or not visual_source_eligible(file_key, row["file"], row["source_type"]):
            return False
        upload_bytes(frame_cache_key(file_key), payload, "application/json")
    return True
