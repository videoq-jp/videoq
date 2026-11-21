"""Compare providers on public Japanese/English fixtures; never writes application data."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import time

from whisper_runtime_validation import assess_response
from worker_python.pipeline.transcription import _whisper_transcribe


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--backends", nargs="+", choices=["openrouter", "workers-ai"], default=["openrouter", "workers-ai"])
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[2] / "inference/whisper/tests/fixtures"
    rows = []
    for backend in args.backends:
        required = ["CLOUDFLARE_ACCOUNT_ID", "WORKERS_AI_API_TOKEN"] if backend == "workers-ai" else []
        missing = [name for name in required if not os.environ.get(name)]
        if backend == "openrouter" and not (os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_FEDERATION_POLICY_ID")):
            missing.append("OPENROUTER_API_KEY or OPENROUTER_FEDERATION_POLICY_ID")
        if missing:
            rows.append({"backend": backend, "error": "MissingConfiguration", "missing": missing})
            continue
        os.environ["WHISPER_BACKEND"] = backend
        for language in ("ja", "en"):
            case = json.loads((fixtures / f"fleurs-{language}-00.json").read_text())
            audio = fixtures / case["file"]
            if hashlib.sha256(audio.read_bytes()).hexdigest() != case["sha256"]:
                raise RuntimeError("Fixture checksum mismatch")
            started = time.perf_counter()
            row = {"backend": backend, "fixture": case["name"], "source_seconds": case["duration"]}
            try:
                segments = _whisper_transcribe(audio, language=language)
                row.update(assessment=assess_response({"segments": segments}, case), segments=segments)
                if backend == "workers-ai":
                    row["estimated_inference_usd"] = case["duration"] / 60 * 0.000513
            except Exception as error:
                # Exception bodies may contain tokens or provider request content.
                row["error"] = type(error).__name__
            row["elapsed_seconds"] = time.perf_counter() - started
            rows.append(row)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"cases": rows, "pricing_checked": "2026-11-21", "scope": "public short speech fixtures; not a production quality gate"}, ensure_ascii=False, indent=2) + "\n")
    return int(any("error" in row or row["assessment"]["errors"] for row in rows))


if __name__ == "__main__":
    raise SystemExit(main())
