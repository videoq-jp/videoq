"""Signed, bounded worker-to-Hono persistence calls; no database fallback."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def uses_internal_persistence() -> bool:
    backend = os.environ.get("PERSISTENCE_BACKEND", "").strip()
    edition = os.environ.get("DEPLOYMENT_EDITION", "").strip()
    if backend not in {"", "d1", "postgres"} or edition not in {"", "cloud", "onprem"}:
        raise RuntimeError("Invalid persistence configuration")
    if edition == "onprem" and backend == "d1":
        raise RuntimeError("On-premises requires PostgreSQL")
    if edition == "cloud" and backend == "postgres":
        if os.environ.get("MIGRATION_ALLOW_CLOUD_POSTGRES") != "true":
            raise RuntimeError("Cloud PostgreSQL requires explicit migration override")
        return False
    return backend == "d1" or edition == "cloud"


def call_internal_api(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    account_action = action == "account-delete/step"
    scene_action = action.startswith("scene-index/")
    processing_action = action == "processing/reserve"
    transcription_action = action.startswith("transcription/")
    checkpoint_action = action.startswith("checkpoints/")
    visual_action = action.startswith("visual/")
    reindex_action = action == "reindex/page"
    if action not in {"claim", "complete", "fail", "heartbeat", "account-delete/step",
                      "scene-index/source", "scene-index/start", "scene-index/stage", "scene-index/publish", "scene-index/finish", "processing/reserve", "transcription/source", "transcription/begin", "transcription/finish", "checkpoints/load", "checkpoints/initialize", "checkpoints/pending",
                      "checkpoints/state", "checkpoints/save", "checkpoints/failure", "checkpoints/segments", "checkpoints/reject", "checkpoints/finish", "visual/load", "visual/initialize", "visual/pending", "visual/chunks",
                      "visual/publish", "visual/ready", "visual/failure", "visual/begin-object", "reindex/page"}:
        raise ValueError("Invalid internal operation")
    origin = os.environ.get("WORKER_INTERNAL_API_ORIGIN", "").rstrip("/")
    parsed = urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment):
        raise RuntimeError("WORKER_INTERNAL_API_ORIGIN must be an HTTPS origin")
    secret = os.environ.get("WORKER_INTERNAL_API_SECRET", "")
    if len(secret.encode("utf-8")) < 32:
        raise RuntimeError("WORKER_INTERNAL_API_SECRET must contain at least 32 bytes")
    path = f"/internal/worker/{action}" if scene_action or processing_action or transcription_action or checkpoint_action or visual_action or reindex_action or account_action else f"/internal/worker/jobs/{action}"
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request_limit = 1_900_000 if transcription_action else (1_900_000 if checkpoint_action else (1_000_000 if scene_action else 8192))
    if len(body) > request_limit:
        raise ValueError("Internal request is too large")
    timestamp = str(int(time.time()))
    message = f"videoq-worker-v1\n{timestamp}\nPOST\n{origin}\n{path}\n".encode() + body
    signature = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    request = Request(origin + path, data=body, method="POST", headers={
        "Content-Type": "application/json", "X-Videoq-Worker-Timestamp": timestamp,
        "X-Videoq-Worker-Signature": signature,
    })
    # Never forward credentials across redirects or log provider response bodies.
    try:
        with build_opener(_NoRedirect()).open(request, timeout=30) as response:
            response_limit = 2_100_000 if action in {"scene-index/source", "checkpoints/segments"} else (100_000 if action in {"visual/chunks", "visual/pending"} else 8192)
            raw = response.read(response_limit + 1)
            if len(raw) > response_limit:
                raise ValueError("Internal response is too large")
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError("Invalid response")
            return result
    except Exception:
        raise RuntimeError("Worker persistence API request failed") from None
