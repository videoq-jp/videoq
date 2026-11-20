"""Dense stills in one atomic, range-readable object for short-clip focus.

Format: b'VQFOC001', uint32 LE JSON length, JSON index, concatenated JPEGs.
Index frame tuples are [actual PTS milliseconds, offset in JPEG data, length].
Keep this format and limits in sync with the API's focus-frames.ts.
"""

from __future__ import annotations

from contextlib import contextmanager
import json
import math
from pathlib import Path
import shutil
import struct
import tempfile

from worker_python.domain.visual_checkpoints import visual_source_eligible
from worker_python.db import db_connection
from worker_python.pipeline.media_process import media_input_args, run_media_process, media_failure
from worker_python.pipeline.storage import ObjectMediaSource, upload_file
from worker_python.pipeline.visual_frames import MAX_IMAGE_BYTES

MAGIC = b"VQFOC001"
HEADER_BYTES = 12
MAX_INDEX_BYTES = 2 * 1024 * 1024
MAX_PACK_BYTES = 512 * 1024 * 1024
MAX_FRAMES = 36_000


def focus_cache_key(file_key: str) -> str:
    return f"{file_key}.focus-v1.bin"


@contextmanager
def build_focus_cache(video_path: Path | ObjectMediaSource, video_id: int, duration: float):
    if not math.isfinite(duration) or not 0 < duration <= MAX_FRAMES:
        raise ValueError("Focus cache requires a finite duration of at most 10 hours")
    with tempfile.TemporaryDirectory(prefix="videoq-focus-") as tmp:
        root = Path(tmp)
        images, timing, pack = root / "frames.mjpg", root / "frames.crc", root / "focus.bin"
        # tee encodes once; framecrc records the *same* JPEG packet's PTS/size.
        # Do not use fps/setpts: duplicating or retiming frames would invent evidence.
        filters = (
            "select='isnan(prev_selected_t)+gte(t-prev_selected_t,1)',"
            "scale=1024:1024:force_original_aspect_ratio=decrease:force_divisible_by=2,"
            "settb=1/1000"
        )
        result = run_media_process([
            "ffmpeg", "-nostdin", "-v", "error", "-y", *media_input_args(video_path),
            "-map", "0:v:0", "-an", "-vf", filters,
            "-fps_mode", "vfr", "-enc_time_base", "1:1000", "-c:v", "mjpeg",
            # Bound MJPEG frame threads under the subprocess memory limit.
            "-threads:v", "1", "-q:v", "8", "-frames:v", str(MAX_FRAMES + 1), "-f", "tee",
            f"[f=image2pipe]{images}|[f=framecrc]{timing}",
        ], max_output_bytes=MAX_PACK_BYTES - MAX_INDEX_BYTES - HEADER_BYTES)
        if result.returncode:
            raise RuntimeError(media_failure("Focus extraction", result))
        frames = []
        offset = 0
        time_base_valid = False
        with timing.open() as index, images.open("rb") as data:
            for line in index:
                if line.startswith("#tb "):
                    time_base_valid = line.strip() == "#tb 0: 1/1000"
                if line.startswith("#") or not line.strip():
                    continue
                fields = line.split(",")
                if not time_base_valid or len(fields) < 6 or int(fields[0]) != 0:
                    raise ValueError("Invalid focus frame timing stream")
                timestamp, size = int(fields[2]), int(fields[4])
                if not 0 <= timestamp <= duration * 1000 or (frames and timestamp - frames[-1][0] < 999):
                    raise ValueError("Invalid focus frame timestamp")
                if not 0 < size <= MAX_IMAGE_BYTES or len(frames) >= MAX_FRAMES:
                    raise ValueError("Focus frame exceeds limits")
                image = data.read(size)
                if len(image) != size or not image.startswith(b"\xff\xd8\xff") or not image.endswith(b"\xff\xd9"):
                    raise ValueError("Invalid focus JPEG packet")
                frames.append([timestamp, offset, size])
                offset += size
            if not frames or data.read(1):
                raise ValueError("Focus timing does not cover the image data")
        manifest = json.dumps({
            "version": 1, "video_id": video_id, "duration_seconds": duration,
            "sampling_interval_seconds": 1, "frames": frames,
        }, separators=(",", ":")).encode()
        if len(manifest) > MAX_INDEX_BYTES or HEADER_BYTES + len(manifest) + offset > MAX_PACK_BYTES:
            raise ValueError("Focus cache exceeds size limit")
        with pack.open("wb") as out, images.open("rb") as data:
            out.write(MAGIC + struct.pack("<I", len(manifest)))
            out.write(manifest)
            shutil.copyfileobj(data, out, length=1024 * 1024)
        yield pack


def publish_focus_cache(video_id: int, file_key: str, pack: Path) -> bool:
    if not HEADER_BYTES < pack.stat().st_size <= MAX_PACK_BYTES:
        raise ValueError("Invalid focus cache size")
    # Same lock as deletion/replacement. A single atomic object prevents readers
    # seeing a new index with old images, and makes cleanup a deterministic key.
    with db_connection() as conn:
        row = conn.execute(
            "SELECT file, source_type FROM videos WHERE id = %s FOR UPDATE", (video_id,),
        ).fetchone()
        if not row or not visual_source_eligible(file_key, row["file"], row["source_type"]):
            return False
        upload_file(focus_cache_key(file_key), pack, "application/octet-stream")
    return True
