"""Prepare private, frozen query embeddings; never connect to persistence or queues."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import sys
from urllib.parse import urlsplit

from worker_python.env import env_str
from worker_python.pipeline.ai_connection import is_openrouter, shared_base_url
from worker_python.pipeline.embedding_contract import resolve_embedding_config, validate_embedding
from worker_python.pipeline.embeddings import embed_texts

MAX_INPUT_BYTES = 2 * 1024 * 1024
BATCH_SIZE = 16


class EvaluationError(RuntimeError):
    """Static diagnostic code only: input/provider details must stay private."""


def _fail(code: str):
    raise EvaluationError(code) from None


def _parent(path: Path) -> Path:
    try:
        parent = path.parent.resolve(strict=True)
        info = parent.stat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.getuid():
            _fail("private_path_required")
        return parent
    except OSError:
        _fail("private_path_required")


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("invalid_manifest")
        result[key] = value
    return result


def _read(path: Path):
    parent = _parent(path)
    try:
        descriptor = os.open(parent / path.name, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
                _fail("private_input_required")
            raw = source.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            _fail("invalid_manifest")
        return json.loads(raw, object_pairs_hook=_object, parse_constant=lambda _: _fail("invalid_manifest"))
    except (OSError, ValueError, UnicodeError):
        _fail("invalid_private_input")


def _integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def validate_manifest(raw):
    try:
        json.dumps(raw, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if not isinstance(raw, dict) or set(raw) != {"version", "cohort", "corpusSha256", "embedding", "samples", "cases"}:
            _fail("invalid_manifest")
        if type(raw["version"]) is not int or raw["version"] != 1 or raw["cohort"] not in {"synthetic", "production-rehearsal"}:
            _fail("invalid_manifest")
        if not isinstance(raw["corpusSha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", raw["corpusSha256"]):
            _fail("invalid_manifest")
        config = raw["embedding"]
        if not isinstance(config, dict) or set(config) != {"provider", "model", "profile", "dimensions", "baseUrl", "authentication"}:
            _fail("invalid_manifest")
        if config["provider"] != "openai" or config["profile"] not in {"openai", "embeddinggemma2"} or not isinstance(config["model"], str) or not 1 <= len(config["model"].strip()) <= 256:
            _fail("invalid_manifest")
        if type(config["dimensions"]) is not int or config["dimensions"] != (768 if config["profile"] == "embeddinggemma2" else 1536):
            _fail("invalid_manifest")
        base = urlsplit(config["baseUrl"])
        if base.scheme not in {"http", "https"} or not base.hostname or base.username or base.password or base.query or base.fragment or config["authentication"] not in {"configured", "workload-federation"}:
            _fail("invalid_manifest")
        if not _integer(raw["samples"], 1, 30) or not isinstance(raw["cases"], list) or not 1 <= len(raw["cases"]) <= 1000:
            _fail("invalid_manifest")
        ids = set()
        for case in raw["cases"]:
            if not isinstance(case, dict) or set(case) != {"id", "question", "userId", "videoIds", "limit"}:
                _fail("invalid_manifest")
            if not isinstance(case["id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", case["id"]) or case["id"] in ids:
                _fail("invalid_manifest")
            ids.add(case["id"])
            if not isinstance(case["question"], str) or not case["question"].strip() or len(case["question"]) > 8000:
                _fail("invalid_manifest")
            if not isinstance(case["userId"], str) or not 1 <= len(case["userId"]) <= 256:
                _fail("invalid_manifest")
            if not isinstance(case["videoIds"], list) or not 1 <= len(case["videoIds"]) <= 10000 or any(not _integer(value, 1, 9007199254740991) for value in case["videoIds"]) or not _integer(case["limit"], 1, 50):
                _fail("invalid_manifest")
        return raw
    except (KeyError, TypeError, ValueError, AttributeError):
        _fail("invalid_manifest")


def _configuration(expected):
    try:
        actual = resolve_embedding_config()
        base = (env_str("EMBEDDING_BASE_URL") or shared_base_url()).rstrip("/")
        federation = is_openrouter(base) and bool(env_str("OPENROUTER_FEDERATION_POLICY_ID"))
        if (actual.provider, actual.model, actual.profile, actual.dimensions, base, "workload-federation" if federation else "configured") != (
            expected["provider"], expected["model"], expected["profile"], expected["dimensions"], expected["baseUrl"].rstrip("/"), expected["authentication"]
        ):
            _fail("configuration_mismatch")
        if federation:
            if not base.startswith("https://") or not (env_str("AWS_REGION") or env_str("AWS_DEFAULT_REGION")):
                _fail("federation_configuration_required")
        elif not (env_str("EMBEDDING_API_KEY") or env_str("OPENROUTER_API_KEY" if is_openrouter(base) else "OPENAI_API_KEY")):
            _fail("configured_credentials_required")
        return actual
    except EvaluationError:
        raise
    except Exception:
        _fail("invalid_embedding_configuration")


def prepare(input_path: Path, output_path: Path, *, execute: bool = False) -> dict:
    manifest = validate_manifest(_read(input_path))
    config = _configuration(manifest["embedding"])
    parent = _parent(output_path)
    destination = parent / output_path.name
    if os.path.lexists(destination):
        _fail("output_exists")
    queries = list(dict.fromkeys(case["question"] for case in manifest["cases"]))
    summary = {"cases": len(manifest["cases"]), "unique_queries": len(queries), "dimensions": config.dimensions}
    if not execute:
        return {"status": "ready", **summary, "model_calls_made": False, "execute_required": True}
    lock = parent / ("." + output_path.name + ".lock")
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
    except OSError:
        _fail("output_locked")
    temporary = None
    try:
        vectors = {}
        for offset in range(0, len(queries), BATCH_SIZE):
            _configuration(manifest["embedding"])
            batch = queries[offset:offset + BATCH_SIZE]
            try:
                result = embed_texts(batch, input_type="query")
                if not isinstance(result, list) or len(result) != len(batch):
                    _fail("invalid_embedding_output")
                for question, vector in zip(batch, result, strict=True):
                    vectors[question] = validate_embedding(vector, config)
            except Exception:
                _fail("embedding_failed")
        payload = {
            "version": 1, "cohort": manifest["cohort"], "corpusSha256": manifest["corpusSha256"],
            "model": config.model, "dimensions": config.dimensions, "samples": manifest["samples"],
            "cases": [{"queryEmbedding": vectors[case["question"]], "userId": case["userId"], "videoIds": list(dict.fromkeys(case["videoIds"])), "limit": case["limit"]} for case in manifest["cases"]],
            "generation": {"version": 1, "manifest_sha256": hashlib.sha256(json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                           "embedding": manifest["embedding"], "case_ids": [case["id"] for case in manifest["cases"]],
                           "unique_queries": len(queries), "input_type": "query", "quality_evaluated": False},
        }
        try:
            descriptor, temporary = tempfile.mkstemp(prefix=".videoq-query-", dir=parent)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                os.fchmod(output.fileno(), 0o600)
                json.dump(payload, output, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.link(temporary, destination)  # Atomically publish without replacing any existing file.
        except Exception:
            _fail("output_write_failed")
        return {"status": "written", **summary, "model_calls_made": True, "quality_evaluated": False}
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
        lock.unlink(missing_ok=True)


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise EvaluationError("invalid_arguments")


def cli(argv=None) -> int:
    """The installed worker package can run this isolated command via python -m."""
    try:
        parser = _Parser(description=__doc__)
        parser.add_argument("--input", type=Path, required=True)
        parser.add_argument("--output", type=Path, required=True)
        parser.add_argument("--execute", action="store_true", help="Make paid model calls; default is offline preflight only.")
        args = parser.parse_args(argv)
        print(json.dumps(prepare(args.input, args.output, execute=args.execute)))
        return 0
    except Exception as error:
        # Never print paths, questions, vectors, SDK exceptions or credentials.
        allowed = {"invalid_arguments", "private_path_required", "private_input_required", "invalid_manifest", "invalid_private_input",
                   "configuration_mismatch", "federation_configuration_required", "configured_credentials_required",
                   "invalid_embedding_configuration", "output_exists", "output_locked", "embedding_failed", "output_write_failed"}
        code = str(error) if isinstance(error, EvaluationError) and str(error) in allowed else "evaluation_failed"
        print(json.dumps({"status": "failed", "code": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(cli())
