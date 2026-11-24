"""OpenAI SDK connection to our signed, bounded audio API; inference uses AI binding."""
import hashlib
import hmac
import math
import time
from pathlib import Path

import httpx
from openai import OpenAI

from worker_python.internal_api import _settings

MODEL = "@cf/openai/whisper-large-v3-turbo"
MAX_AUDIO_BYTES = 3_000_000


def validate_audio(audio: Path, duration: float) -> float:
    if not math.isfinite(duration) or not 0 < duration <= 300.5:
        raise ValueError("Invalid Workers AI audio duration")
    if not 0 < audio.stat().st_size <= MAX_AUDIO_BYTES:
        raise ValueError("Workers AI audio chunk is too large or empty")
    return duration


def create_client(*, transport: httpx.BaseTransport | None = None) -> OpenAI:
    origin, secret = _settings()
    path = "/internal/worker/audio/transcriptions"

    def sign(request: httpx.Request) -> None:
        # The SDK requires a constructor value, but no bearer/API key is sent.
        for header in ("authorization", "openai-organization", "openai-project"):
            request.headers.pop(header, None)
        if request.method != "POST" or str(request.url) != origin + path:
            raise RuntimeError("Invalid signed transcription destination")
        body = request.read()
        if len(body) > 3_100_000:
            raise ValueError("Internal audio request is too large")
        timestamp = str(int(time.time()))
        prefix = f"videoq-worker-v1\n{timestamp}\nPOST\n{origin}\n{path}\n".encode()
        request.headers["X-Videoq-Worker-Timestamp"] = timestamp
        request.headers["X-Videoq-Worker-Signature"] = hmac.new(secret.encode(), prefix + body, hashlib.sha256).hexdigest()

    class BoundedTransport(httpx.BaseTransport):
        def __init__(self):
            self.inner = transport if transport is not None else httpx.HTTPTransport()

        def handle_request(self, request: httpx.Request) -> httpx.Response:
            response = self.inner.handle_request(request)
            size = 0
            chunks = []
            try:
                for chunk in response.iter_bytes(chunk_size=65_536):
                    size += len(chunk)
                    if size > 1_000_000:
                        raise RuntimeError("Internal audio response is too large")
                    chunks.append(chunk)
                # Rebuild a bounded response using public APIs before SDK parsing.
                headers = [(key, value) for key, value in response.headers.multi_items()
                           if key.lower() not in {"content-encoding", "content-length", "transfer-encoding"}]
                return httpx.Response(response.status_code, headers=headers,
                                      content=b"".join(chunks), extensions=response.extensions)
            finally:
                response.close()

        def close(self) -> None:
            self.inner.close()

    return OpenAI(
        api_key="unused-internal-signature", base_url=origin + "/internal/worker/",
        timeout=120, max_retries=0, default_headers={"User-Agent": "VideoQ-Worker/1.0"},
        http_client=httpx.Client(
            transport=BoundedTransport(), trust_env=False, follow_redirects=False, timeout=120,
            headers={"User-Agent": "VideoQ-Worker/1.0"},
            event_hooks={"request": [sign]},
        ),
    )


def validate_segments(result, duration: float) -> None:
    segments = getattr(result, "segments", None)
    if not isinstance(segments, list) or len(segments) > 2000:
        raise RuntimeError("Invalid Workers AI transcription response")
    previous = 0.0
    for item in segments:
        segment = item if isinstance(item, dict) else item.model_dump()
        start, end, text = segment.get("start"), segment.get("end"), segment.get("text")
        if (type(start) not in {int, float} or type(end) not in {int, float}
                or not isinstance(text, str) or not text.strip()
                or not math.isfinite(start) or not math.isfinite(end)
                or not previous <= start < end <= duration):
            raise RuntimeError("Invalid Workers AI transcription timestamps")
        previous = start
    if not segments and getattr(result, "text", "").strip():
        raise RuntimeError("Workers AI must return real segment timestamps")
