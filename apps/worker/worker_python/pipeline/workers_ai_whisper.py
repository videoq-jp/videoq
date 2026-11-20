"""Workers AI speech through the AWS OIDC-authenticated binding proxy."""
from __future__ import annotations

import base64
import math
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from worker_python.env import env_str

MODEL = "@cf/openai/whisper-large-v3-turbo"


def create_client() -> httpx.Client:
    from .workers_ai_federation import WorkloadIdentityAuth
    endpoint = env_str("WORKERS_AI_BASE_URL")
    url = urlsplit(endpoint)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path != "/api/internal/workers-ai/transcribe"):
        raise RuntimeError("Workers AI requires an HTTPS WORKERS_AI_BASE_URL federation endpoint")
    return httpx.Client(
        base_url=endpoint.rsplit("/", 1)[0] + "/",
        auth=WorkloadIdentityAuth(endpoint), timeout=120.0,
        follow_redirects=False,
    )


def transcribe(client: httpx.Client, audio: Path, *, offset: float, language: str | None = None) -> list[dict]:
    # 300 seconds at the pipeline's 64 kbps is approximately 2.4 MB.
    if audio.stat().st_size > 4 * 1024 * 1024:
        raise RuntimeError("Workers AI audio chunk exceeds 4 MiB")
    response = client.post("transcribe", json={
        "audio": base64.b64encode(audio.read_bytes()).decode("ascii"),
        "task": "transcribe", "vad_filter": True, "condition_on_previous_text": False,
        **({"language": language} if language else {}),
    })
    if response.status_code != 200:
        raise RuntimeError(f"Workers AI transcription failed (HTTP {response.status_code})")
    payload = response.json()
    result = payload.get("result")
    if payload.get("success") is not True or not isinstance(result, dict):
        raise RuntimeError("Workers AI transcription returned an unsuccessful response")
    rows = result.get("segments", [])
    if not isinstance(rows, list):
        raise RuntimeError("Workers AI returned invalid segments")
    out = []
    previous = -1.0
    for row in rows:
        if not isinstance(row, dict):
            raise RuntimeError("Workers AI returned invalid segment")
        start, end, text = row.get("start"), row.get("end"), row.get("text")
        if (isinstance(start, bool) or isinstance(end, bool)
                or not isinstance(start, (int, float)) or not isinstance(end, (int, float))
                or not math.isfinite(start) or not math.isfinite(end)
                or start < 0 or end <= start or start < previous or not isinstance(text, str)):
            raise RuntimeError("Workers AI returned invalid segment timestamps/text")
        previous = start
        out.append({"start": start + offset, "end": end + offset, "text": text})
    info = result.get("transcription_info")
    if not out and (result.get("text") or (isinstance(info, dict) and info.get("text"))):
        raise RuntimeError("Workers AI must return real segment timestamps")
    return out
