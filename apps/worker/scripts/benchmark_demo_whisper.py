"""Evaluate the repository's original narrated demo lessons; no application writes.

These synthetic one-minute lessons are additional smoke coverage, not a natural
lecture benchmark. Set WHISPER_BACKEND and credentials explicitly before running.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

from whisper_runtime_validation import assess_response
from worker_python.pipeline.transcription import _ffmpeg_extract_mp3, _whisper_transcribe


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2] / "demo-video"
    lessons = json.loads((root / "content/course.json").read_text())["lessons"]
    timings = {row["key"]: row for row in json.loads((root / "public/lessons/manifest.json").read_text())}
    rows = []
    for lesson in lessons:
        video = root / "public/lessons" / f'{lesson["key"]}.mp4'
        timing = timings[lesson["key"]]
        case = {"reference": "".join(c["narration"] for c in lesson["chapters"]),
                "duration": timing["duration"],
                "regions": [{"start": t["start"], "end": t["end"], "reference": c["narration"]}
                            for c, t in zip(lesson["chapters"], timing["chapters"], strict=True)]}
        row = {"lesson": lesson["key"], "source_seconds": timing["duration"],
               "video_sha256": hashlib.sha256(video.read_bytes()).hexdigest()}
        started = time.perf_counter()
        try:
            with tempfile.TemporaryDirectory(prefix="videoq-demo-whisper-") as tmp:
                audio = Path(tmp) / "audio.mp3"
                _ffmpeg_extract_mp3(video, audio)
                segments = _whisper_transcribe(audio, language="ja")
            row.update(assessment=assess_response({"segments": segments}, case), segments=segments)
        except Exception as error:
            row["error_type"] = type(error).__name__
        row["elapsed_seconds_including_extraction"] = time.perf_counter() - started
        rows.append(row)
    report = {"backend": os.environ.get("WHISPER_BACKEND", "default"), "scope": "five original Kyoko synthetic-speech demo lessons, not natural lectures",
              "reference": "apps/demo-video/content/course.json chapter narration",
              "cases": rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return int(any("error_type" in row or row["assessment"]["errors"] for row in rows))


if __name__ == "__main__":
    raise SystemExit(main())
