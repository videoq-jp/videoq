"""Explicitly enabled, synchronous embedding-only Lambda entrypoint.

Not registered with SQS or the normal worker handler. Deployment must select this
entrypoint on an isolated function; it does not bootstrap SSM/DB credentials.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import tempfile

from worker_python.search_evaluation import EvaluationError, prepare, validate_manifest

MAX_CASES = 16
MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MIN_REMAINING_MS = 240000


def _failure(code):
    return {"version": 1, "status": "failed", "code": code, "quality_evaluated": False}


def handler(event, context):
    # Fail closed even if this entrypoint is selected by mistake. Enabling the
    # dedicated function is an explicit operator-managed configuration change.
    if os.environ.get("VIDEOQ_SEARCH_EVALUATION_ENABLED") != "true":
        return _failure("evaluation_disabled")
    try:
        if (not isinstance(event, dict) or set(event) != {"version", "operation", "manifest"}
                or type(event["version"]) is not int or event["version"] != 1
                or event["operation"] != "prepare_query_embeddings"):
            return _failure("invalid_request")
        serialized = json.dumps(event["manifest"], ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(serialized) > MAX_REQUEST_BYTES:
            return _failure("invalid_request")
        manifest = validate_manifest(event["manifest"])
        if len(manifest["cases"]) > MAX_CASES:
            return _failure("too_many_cases")
        # This cloud runtime uses the existing workload's identity, never a
        # caller-supplied API key, role, endpoint, environment or command override.
        if manifest["embedding"]["authentication"] != "workload-federation":
            return _failure("workload_federation_required")
        remaining = context.get_remaining_time_in_millis()
        if type(remaining) is not int or remaining < MIN_REMAINING_MS:
            return _failure("insufficient_execution_time")
        with tempfile.TemporaryDirectory(prefix="videoq-query-evaluation-") as directory:
            parent = Path(directory)
            parent.chmod(0o700)
            source, destination = parent / "manifest.json", parent / "vectors.json"
            descriptor = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                output.write(serialized)
            summary = prepare(source, destination, execute=True)
            result = json.loads(destination.read_text(encoding="utf-8"))
            response = {"version": 1, "status": "complete", "summary": summary,
                        "manifest_sha256": hashlib.sha256(serialized).hexdigest(),
                        "evaluation_input": result, "quality_evaluated": False}
            if len(json.dumps(response, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_RESPONSE_BYTES:
                return _failure("response_too_large")
            return response
    except EvaluationError as error:
        # Only errors emitted by this package carry static diagnostic codes.
        allowed = {"configuration_mismatch", "federation_configuration_required", "configured_credentials_required",
                   "invalid_embedding_configuration", "embedding_failed", "invalid_manifest"}
        return _failure(str(error) if str(error) in allowed else "evaluation_failed")
    except Exception:
        # Lambda otherwise logs uncaught exception traces, including SDK causes.
        return _failure("evaluation_failed")
