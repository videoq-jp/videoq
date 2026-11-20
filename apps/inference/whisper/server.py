"""Private subtitle gateway for CPU whisper.cpp and NVIDIA vLLM.

Weights are provisioned before serving. Only loopback inference is contacted;
clients cannot choose models, URLs, decoding commands or downloaded code.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
import io
import json
import os
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore, Lock
import time
from typing import Annotated
import wave

from fastapi import FastAPI, Form, HTTPException, UploadFile
import httpx
import numpy as np
from starlette.responses import JSONResponse

from transcription_core import RATE, merge_speech_spans, restore_segments, TranscriptionDependencies, execute_transcription
MODEL_ALIAS = "whisper-local"
MAX_AUDIO_BYTES = 24 * 1024 * 1024
MAX_BODY_BYTES = MAX_AUDIO_BYTES + 64 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
UPSTREAM = "http://127.0.0.1:8081"
vad_lock = Lock()


def setting(name, default, maximum):
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError as error:
        raise ValueError(f"{name} must be an integer from 1 to {maximum}") from error
    if not 1 <= value <= maximum:
        raise ValueError(f"{name} must be an integer from 1 to {maximum}")
    return value


class RequestLimits:
    """Bound concurrent uploads and multipart bytes before FastAPI spools files."""
    def __init__(self, app):
        self.app = app
        self.slots = BoundedSemaphore(setting("WHISPER_MAX_CONCURRENT_REQUESTS", 1, 4))

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] != "/v1/audio/transcriptions":
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            return await JSONResponse({"detail": "Invalid content length"}, 400)(scope, receive, send)
        if length < 0 or length > MAX_BODY_BYTES:
            return await JSONResponse({"detail": "Request exceeds upload limit"}, 413)(scope, receive, send)
        if not self.slots.acquire(blocking=False):
            return await JSONResponse({"detail": "Transcription server is busy"}, 503,
                                      headers={"Retry-After": "5"})(scope, receive, send)
        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > MAX_BODY_BYTES:
                raise HTTPException(413, "Request exceeds upload limit")
            return message

        try:
            return await self.app(scope, limited_receive, send)
        finally:
            self.slots.release()


def load_vad():
    import torch
    from silero_vad import load_silero_vad
    torch.set_num_threads(1)
    # The pinned package bundles its ONNX weights; this never downloads models.
    return load_silero_vad(onnx=True)


@asynccontextmanager
async def lifespan(app):
    app.state.parallelism = setting("WHISPER_UPSTREAM_PARALLELISM", 1, 8)
    app.state.request_timeout = setting("WHISPER_REQUEST_TIMEOUT_SECONDS", 600, 600)
    app.state.vad = load_vad()
    with httpx.Client(base_url=UPSTREAM, timeout=5, trust_env=False,
                      limits=httpx.Limits(max_connections=32, max_keepalive_connections=16)) as client:
        app.state.upstream = client
        yield
    del app.state.upstream
    del app.state.vad


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(RequestLimits)


@app.get("/live")
def live():
    return {"status": "ok"}


@app.get("/health")
def health():
    try:
        if not hasattr(app.state, "vad") or app.state.upstream.get("/health").status_code != 200:
            raise HTTPException(503, "Inference engine is not ready")
    except httpx.HTTPError as error:
        raise HTTPException(503, "Inference engine is not ready") from error
    return {"status": "ok"}


def decode_audio(path, directory):
    output = directory / "decoded.f32"
    subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-y", "-threads", "1", "-filter_threads", "1",
        "-protocol_whitelist", "file", "-format_whitelist", "mp3,wav,flac",
        "-i", str(path), "-map", "0:a:0", "-vn", "-t", "301.1", "-af", "dynaudnorm=f=250:g=5:m=100",
        "-ar", str(RATE), "-ac", "1", "-f", "f32le", "-fs", str(RATE * 4 * 302), str(output),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True)
    audio = np.fromfile(output, dtype="<f4")
    if not 0 < len(audio) <= RATE * 301 or not np.isfinite(audio).all():
        raise ValueError("Audio must fit one 300-second worker interval")
    return audio


def speech_spans(audio):
    from silero_vad import get_speech_timestamps
    with vad_lock:
        regions = get_speech_timestamps(
            audio, app.state.vad, sampling_rate=RATE, min_speech_duration_ms=0,
            min_silence_duration_ms=300, speech_pad_ms=400, max_speech_duration_s=28,
        )
    return merge_speech_spans(regions)


def recognize(audio, span, language, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("Transcription deadline exceeded")
    start, end = span
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes((np.clip(audio[start:end], -1, 1) * 32767).astype("<i2").tobytes())
    data = {"model": MODEL_ALIAS, "response_format": "verbose_json", "timestamp_granularities[]": "segment"}
    if language:
        data["language"] = language
    # Fixed loopback endpoint; never use HTTP proxy settings or provider fallback.
    with app.state.upstream.stream(
        "POST", "/v1/audio/transcriptions", data=data, files={"file": ("speech.wav", output.getvalue(), "audio/wav")},
        timeout=httpx.Timeout(remaining, connect=min(5, remaining)),
    ) as response:
        response.raise_for_status()
        body = bytearray()
        for chunk in response.iter_bytes():
            body.extend(chunk)
            if len(body) > MAX_RESPONSE_BYTES:
                raise ValueError("Upstream response exceeds limit")
        payload = json.loads(body)
    return start, end, payload


def recognize_spans(audio, spans, language, deadline):
    with ThreadPoolExecutor(max_workers=app.state.parallelism) as pool:
        return list(pool.map(lambda span: recognize(audio, span, language, deadline), spans))


@app.post("/v1/audio/transcriptions")
def transcribe(
    file: UploadFile,
    model: Annotated[str, Form()],
    response_format: Annotated[str, Form()] = "verbose_json",
    timestamp_granularities: Annotated[list[str], Form(alias="timestamp_granularities[]")] = ["segment"],
    language: Annotated[str | None, Form()] = None,
):
    deadline = time.monotonic() + app.state.request_timeout
    try:
        if model != MODEL_ALIAS or response_format != "verbose_json" or timestamp_granularities != ["segment"]:
            raise HTTPException(400, "Use whisper-local, verbose_json and segment timestamps")
        if language and not re.fullmatch(r"[a-z]{2,3}", language):
            raise HTTPException(400, "Invalid language code")
        with TemporaryDirectory(prefix="videoq-whisper-") as name:
            directory = Path(name)
            path, size = directory / "audio", 0
            with path.open("wb") as output:
                while chunk := file.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_AUDIO_BYTES:
                        raise HTTPException(413, "Audio exceeds 24 MiB")
                    output.write(chunk)
            if not size:
                raise HTTPException(400, "Audio is empty")
            audio = decode_audio(path, directory)
            return execute_transcription(audio, TranscriptionDependencies(
                duration=lambda value: len(value) / RATE,
                speech_spans=speech_spans,
                recognize=recognize_spans,
                now=time.monotonic,
            ), language=language, deadline=deadline)
    except (subprocess.SubprocessError, ValueError, RuntimeError) as error:
        raise HTTPException(422, "Audio or subtitle response could not be processed") from error
    except (httpx.TimeoutException, TimeoutError) as error:
        raise HTTPException(504, "Inference engine timed out") from error
    except httpx.HTTPError as error:
        raise HTTPException(502, "Inference engine request failed") from error
    finally:
        file.file.close()
