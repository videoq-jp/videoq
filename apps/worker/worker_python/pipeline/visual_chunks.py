"""One minute of source decoding, with real global PTS and bounded output."""

from contextlib import contextmanager
import base64
import json
import math
from pathlib import Path
import shutil
import struct
import tempfile

from worker_python.pipeline.media_process import media_input_args, run_media_process, media_failure
from worker_python.pipeline.storage import ObjectMediaSource
from worker_python.pipeline.visual_frames import MAX_IMAGE_BYTES, MAX_CACHE_BYTES

CHUNK_SECONDS = 60
MAX_DURATION_SECONDS = 36_000
MAX_CHUNK_BYTES = CHUNK_SECONDS * MAX_IMAGE_BYTES + 64 * 1024


def visual_prefix(file_key: str) -> str:
    return f"{file_key}.visual-v2/"


def chunk_key(file_key: str, run_id: str, index: int, extension: str = "bin", *, object_version: str | None = None) -> str:
    suffix = f"{index}/{object_version}" if object_version else str(index)
    return f"{visual_prefix(file_key)}{run_id}/{suffix}.{extension}"


def manifest_key(file_key: str) -> str:
    return f"{file_key}.focus-v2.json"


@contextmanager
def build_visual_chunk(source: Path | ObjectMediaSource, video_id: int, duration: float, index: int):
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION_SECONDS:
        raise ValueError("Visual inspection supports videos up to 10 hours")
    if type(index) is not int or not 0 <= index < math.ceil(duration / CHUNK_SECONDS):
        raise ValueError("Invalid visual chunk index")
    start, end = index * CHUNK_SECONDS, min((index + 1) * CHUNK_SECONDS, duration)
    # A 60fps recording only needs one image per second. Decoding its discarded
    # non-reference frames wastes CPU; reference frames retain their real PTS.
    # Low-frame-rate sources and source gaps may lose occupied seconds with
    # this optimization. Retry with full decoding unless every second is covered.
    expected_seconds = math.ceil(end) - start
    for skip_nonreference in (True, False):
        with _extract_visual_chunk(source, video_id, duration, start, end,
                                   skip_nonreference=skip_nonreference) as result:
            if skip_nonreference and result[2] < expected_seconds:
                continue
            yield result
            return


@contextmanager
def _extract_visual_chunk(
    source: Path | ObjectMediaSource, video_id: int, duration: float,
    start: int, end: float, *, skip_nonreference: bool,
):
    with tempfile.TemporaryDirectory(prefix="videoq-visual-chunk-") as tmp:
        root = Path(tmp)
        images, timing, pack = root / "frames.mjpg", root / "frames.crc", root / "focus.bin"
        # Input seeking avoids decoding earlier footage. copyts/start_at_zero
        # retain the container-relative time, including audio/video offsets.
        # Select one real frame in each global second; never duplicate or retime.
        filters = (
            f"select='gte(t,{start})*"
            "(isnan(prev_selected_t)+gt(floor(t),floor(prev_selected_t)))',"
            "scale=1024:1024:force_original_aspect_ratio=decrease:force_divisible_by=2,settb=1/1000"
        )
        result = run_media_process([
            "ffmpeg", "-nostdin", "-v", "error", "-y", "-copyts", "-start_at_zero",
            "-ss", str(start), "-threads", "2",
            *(["-skip_frame", "noref"] if skip_nonreference else []),
            *media_input_args(source), "-to", f"{end:.6f}",
            "-map", "0:v:0", "-an", "-vf", filters, "-filter_threads", "1",
            "-fps_mode", "vfr", "-enc_time_base", "1:1000", "-c:v", "mjpeg",
            "-threads:v", "1", "-q:v", "8", "-frames:v", str(CHUNK_SECONDS + 1), "-f", "tee",
            f"[f=image2pipe]{images}|[f=framecrc]{timing}",
        ], max_output_bytes=MAX_CHUNK_BYTES, timeout_seconds=300)
        if result.returncode:
            raise RuntimeError(media_failure("Visual chunk extraction", result))
        frames, sparse = [], []
        offset = 0
        time_base_valid = False
        interval = max(5, duration / 240)
        # Every coarse sampling target belongs to exactly one source minute.
        targets = [i * interval for i in range(240) if start <= i * interval < end]
        target_index = 0
        with timing.open() as timestamps, images.open("rb") as data:
            for line in timestamps:
                if line.startswith("#tb "):
                    time_base_valid = line.strip() == "#tb 0: 1/1000"
                if line.startswith("#") or not line.strip():
                    continue
                fields = line.split(",")
                if not time_base_valid or len(fields) < 6 or int(fields[0]) != 0:
                    raise ValueError("Invalid visual chunk timing stream")
                time_ms, size = int(fields[2]), int(fields[4])
                if not start * 1000 <= time_ms < end * 1000 or (frames and time_ms // 1000 <= frames[-1][0] // 1000):
                    raise ValueError("Invalid visual chunk timestamp")
                if not 0 < size <= MAX_IMAGE_BYTES or len(frames) >= CHUNK_SECONDS:
                    raise ValueError("Visual chunk exceeds image limits")
                image = data.read(size)
                if len(image) != size or not image.startswith(b"\xff\xd8\xff") or not image.endswith(b"\xff\xd9"):
                    raise ValueError("Invalid visual chunk JPEG")
                frames.append([time_ms, offset, size])
                offset += size
                if target_index < len(targets) and time_ms / 1000 >= targets[target_index]:
                    sparse.append({"timestamp_seconds": time_ms / 1000, "jpeg_base64": base64.b64encode(image).decode("ascii"),
                                   "offset": offset - size, "length": size})
                    while target_index < len(targets) and targets[target_index] <= time_ms / 1000:
                        target_index += 1
            if data.read(1):
                raise ValueError("Visual timing does not cover the image data")
        # Empty chunks are valid for gaps in the video stream. The finalizer
        # still rejects an entirely empty video instead of claiming readiness.
        manifest = json.dumps({"version": 1, "video_id": video_id, "duration_seconds": duration,
                               "sampling_interval_seconds": 1, "frames": frames}, separators=(",", ":")).encode()
        with pack.open("wb") as out, images.open("rb") as data:
            out.write(b"VQFOC001" + struct.pack("<I", len(manifest)))
            out.write(manifest)
            shutil.copyfileobj(data, out, length=1024 * 1024)
        if pack.stat().st_size > MAX_CHUNK_BYTES:
            raise ValueError("Visual chunk pack exceeds limit")
        for frame in sparse:
            frame['offset'] += 12 + len(manifest)
        coarse = json.dumps(sparse, separators=(",", ":")).encode()
        if len(coarse) > MAX_CACHE_BYTES:
            raise ValueError("Visual chunk samples exceed limit")
        yield pack, coarse, len(frames)
