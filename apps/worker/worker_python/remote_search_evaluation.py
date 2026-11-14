"""Private, version-pinned client for the dedicated embedding evaluation Lambda."""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

from worker_python.pipeline.embedding_contract import EmbeddingConfig, resolve_embedding_config, validate_embedding
from worker_python.search_evaluation import EvaluationError, _fail, _object, _parent, _read, validate_manifest

MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_CHUNK_BYTES = 1024 * 1024
CHUNK_SIZE = 16


def _digest(value, *, canonical=False):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=canonical,
                                     **({"separators": (",", ":")} if canonical else {})).encode()).hexdigest()


def validate_target(raw):
    try:
        if not isinstance(raw, dict) or set(raw) != {"version", "functionArn", "functionVersion", "imageUri", "roleArn", "federationPolicyId"}:
            _fail("invalid_target")
        if type(raw["version"]) is not int or raw["version"] != 1:
            _fail("invalid_target")
        match = re.fullmatch(r"arn:aws:lambda:ap-northeast-1:([0-9]{12}):function:videoq-search-evaluation-prod", raw["functionArn"])
        if not match or not re.fullmatch(r"[1-9][0-9]{0,8}", raw["functionVersion"]):
            _fail("invalid_target")
        account = match[1]
        image_prefix = f"{account}.dkr.ecr.ap-northeast-1.amazonaws.com/videoq-worker-prod@sha256:"
        if not raw["imageUri"].startswith(image_prefix) or not re.fullmatch(r"[a-f0-9]{64}", raw["imageUri"][len(image_prefix):]):
            _fail("invalid_target")
        if raw["roleArn"] != f"arn:aws:iam::{account}:role/videoq-worker-prod" or not isinstance(raw["federationPolicyId"], str) or not 1 <= len(raw["federationPolicyId"].strip()) <= 256:
            _fail("invalid_target")
        return raw
    except (KeyError, TypeError, AttributeError):
        _fail("invalid_target")


def verify_function(metadata, target, embedding):
    try:
        config = metadata["Configuration"]
        env = config["Environment"]["Variables"]
        allowed_env = {"OPENAI_BASE_URL", "EMBEDDING_MODEL", "EMBEDDING_PROFILE", "EMBEDDING_BASE_URL",
                       "OPENROUTER_FEDERATION_POLICY_ID", "OPENROUTER_FEDERATION_AUDIENCE", "VIDEOQ_SEARCH_EVALUATION_ENABLED"}
        actual = resolve_embedding_config(env)
        base = (env.get("EMBEDDING_BASE_URL") or env.get("OPENAI_BASE_URL") or "https://openrouter.ai/api/v1").strip().rstrip("/")
        image = config["ImageConfigResponse"]
        command = image["ImageConfig"]
        valid = (
            config["Version"] == target["functionVersion"]
            and config["FunctionArn"] in {target["functionArn"], target["functionArn"] + ":" + target["functionVersion"]}
            and config["Role"] == target["roleArn"] and config["PackageType"] == "Image"
            and config["State"] == "Active" and config["LastUpdateStatus"] == "Successful"
            and config["Architectures"] == ["arm64"] and config["MemorySize"] == 512 and config["Timeout"] == 300
            and type(metadata["Concurrency"]["ReservedConcurrentExecutions"]) is int and metadata["Concurrency"]["ReservedConcurrentExecutions"] == 1
            and metadata["Code"]["ResolvedImageUri"] == target["imageUri"]
            and not config["Environment"].get("Error") and not image.get("Error")
            and command["Command"] == ["worker_python.search_evaluation_lambda.handler"]
            and not command.get("EntryPoint") and command.get("WorkingDirectory", "/var/task") in {"", "/var/task"}
            and set(env) <= allowed_env and env["VIDEOQ_SEARCH_EVALUATION_ENABLED"] == "true"
            and env["OPENROUTER_FEDERATION_POLICY_ID"] == target["federationPolicyId"]
            and (env.get("OPENROUTER_FEDERATION_AUDIENCE") or "https://openrouter.ai") == "https://openrouter.ai"
            and (actual.provider, actual.model, actual.profile, actual.dimensions, base) ==
                (embedding["provider"], embedding["model"], embedding["profile"], embedding["dimensions"], embedding["baseUrl"].rstrip("/"))
            and base == "https://openrouter.ai/api/v1" and embedding["authentication"] == "workload-federation"
        )
        if not valid:
            _fail("runtime_mismatch")
    except EvaluationError:
        raise
    except Exception:
        _fail("runtime_mismatch")


def _validated_vectors(response, manifest):
    try:
        data = response["evaluation_input"]
        config = manifest["embedding"]
        if (response["version"] != 1 or type(response["version"]) is not int or response["status"] != "complete" or response["quality_evaluated"] is not False
                or response["manifest_sha256"] != _digest(manifest)
                or set(data) != {"version", "cohort", "corpusSha256", "model", "dimensions", "samples", "cases", "generation"}
                or type(data["version"]) is not int or data["version"] != 1
                or data["cohort"] != manifest["cohort"] or data["corpusSha256"] != manifest["corpusSha256"]
                or data["model"] != config["model"] or type(data["dimensions"]) is not int or data["dimensions"] != config["dimensions"]
                or type(data["samples"]) is not int or data["samples"] != 1 or len(data["cases"]) != len(manifest["cases"])):
            _fail("invalid_remote_result")
        generation = data["generation"]
        if (generation["version"] != 1 or type(generation["version"]) is not int or generation["manifest_sha256"] != _digest(manifest, canonical=True)
                or generation["embedding"] != config or generation["case_ids"] != [case["id"] for case in manifest["cases"]]
                or generation["input_type"] != "query" or generation["quality_evaluated"] is not False
                or type(generation["unique_queries"]) is not int or generation["unique_queries"] != len(manifest["cases"])):
            _fail("invalid_remote_result")
        summary = response["summary"]
        if summary != {"status": "written", "cases": len(manifest["cases"]), "unique_queries": len(manifest["cases"]),
                       "dimensions": config["dimensions"], "model_calls_made": True, "quality_evaluated": False}:
            _fail("invalid_remote_result")
        output = {}
        embedding_config = EmbeddingConfig(config["provider"], config["model"], config["profile"])
        for sent, received in zip(manifest["cases"], data["cases"], strict=True):
            if (set(received) != {"queryEmbedding", "userId", "videoIds", "limit"} or received["userId"] != sent["userId"]
                    or received["videoIds"] != list(dict.fromkeys(sent["videoIds"]))
                    or any(type(value) is not int for value in received["videoIds"])
                    or type(received["limit"]) is not int or received["limit"] != sent["limit"]):
                _fail("invalid_remote_result")
            output[sent["question"]] = validate_embedding(received["queryEmbedding"], embedding_config)
        return output
    except Exception:
        _fail("invalid_remote_result")


def _invoke(client, target, manifest):
    body = json.dumps({"version": 1, "operation": "prepare_query_embeddings", "manifest": manifest}, ensure_ascii=False, allow_nan=False).encode()
    if len(json.dumps(manifest, ensure_ascii=False, allow_nan=False).encode()) > MAX_CHUNK_BYTES:
        _fail("request_too_large")
    try:
        response = client.invoke(FunctionName=target["functionArn"], Qualifier=target["functionVersion"],
                                 InvocationType="RequestResponse", LogType="None", Payload=body)
        with closing(response["Payload"]) as stream:
            if (type(response.get("StatusCode")) is not int or response["StatusCode"] != 200 or response.get("FunctionError")
                    or response.get("ExecutedVersion") != target["functionVersion"] or response.get("LogResult")):
                _fail("remote_invocation_failed")
            raw = stream.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            _fail("invalid_remote_result")
        return _validated_vectors(json.loads(raw, object_pairs_hook=_object, parse_constant=lambda _: _fail("invalid_remote_result")), manifest)
    except EvaluationError:
        raise
    except Exception:
        # No automatic retry: a lost reply may already have incurred model cost.
        _fail("remote_invocation_failed")


def prepare_remote(input_path: Path, output_path: Path, target_path: Path, *, execute=False, client=None):
    manifest, target = validate_manifest(_read(input_path)), validate_target(_read(target_path))
    if manifest["embedding"]["authentication"] != "workload-federation" or manifest["embedding"]["baseUrl"].rstrip("/") != "https://openrouter.ai/api/v1":
        _fail("workload_federation_required")
    destination = _parent(output_path) / output_path.name
    if os.path.lexists(destination):
        _fail("output_exists")
    unique_by_question = {}
    for case in manifest["cases"]:
        unique_by_question.setdefault(case["question"], case)
    unique = list(unique_by_question.values())
    summary = {"cases": len(manifest["cases"]), "unique_queries": len(unique), "invocations": (len(unique) + CHUNK_SIZE - 1) // CHUNK_SIZE}
    chunks = [{**manifest, "samples": 1, "cases": unique[offset:offset + CHUNK_SIZE]} for offset in range(0, len(unique), CHUNK_SIZE)]
    if any(len(json.dumps(chunk, ensure_ascii=False).encode()) > MAX_CHUNK_BYTES for chunk in chunks):
        _fail("request_too_large")
    if not execute:
        return {"status": "ready", **summary, "aws_calls_made": False, "target_verified": False, "execute_required": True}
    if client is None:
        _fail("lambda_client_required")
    lock = destination.parent / ("." + destination.name + ".lock")
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
    except OSError:
        _fail("output_locked")
    temporary = None
    try:
        try:
            metadata = client.get_function(FunctionName=target["functionArn"], Qualifier=target["functionVersion"])
            # Qualified GetFunction does not return function-level concurrency.
            # Read the authoritative setting separately; never infer a default.
            metadata = {**metadata, "Concurrency": client.get_function_concurrency(FunctionName=target["functionArn"])}
        except Exception:
            _fail("runtime_inspection_failed")
        verify_function(metadata, target, manifest["embedding"])
        vectors = {}
        for chunk in chunks:
            vectors.update(_invoke(client, target, chunk))
        payload = {"version": 1, "cohort": manifest["cohort"], "corpusSha256": manifest["corpusSha256"],
                   "model": manifest["embedding"]["model"], "dimensions": manifest["embedding"]["dimensions"], "samples": manifest["samples"],
                   "cases": [{"queryEmbedding": vectors[case["question"]], "userId": case["userId"], "videoIds": list(dict.fromkeys(case["videoIds"])), "limit": case["limit"]} for case in manifest["cases"]],
                   "generation": {"version": 1, "manifest_sha256": _digest(manifest, canonical=True), "embedding": manifest["embedding"],
                                  "case_ids": [case["id"] for case in manifest["cases"]], "input_type": "query", "unique_queries": len(unique),
                                  "runtime": {key: target[key] for key in ["functionArn", "functionVersion", "imageUri", "roleArn"]},
                                  "invocations": len(chunks), "quality_evaluated": False}}
        try:
            descriptor, temporary = tempfile.mkstemp(prefix=".videoq-remote-query-", dir=destination.parent)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                os.fchmod(output.fileno(), 0o600)
                json.dump(payload, output, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.link(temporary, destination)
        except Exception:
            _fail("output_write_failed")
        return {"status": "written", **summary, "target_verified": True, "quality_evaluated": False}
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
        lock.unlink(missing_ok=True)


def _lambda_client():
    import boto3
    from botocore.config import Config
    session = boto3.Session()
    # Evaluation invocation must not acquire the production worker role through
    # an implicit SDK profile/web-identity/process credential provider.
    resolver = session._session.get_component("credential_provider")
    for provider in ["assume-role", "assume-role-with-web-identity", "custom-process"]:
        resolver.remove(provider)
    if session._session.get_scoped_config().get("sso_role_name") == "videoq-worker-prod":
        _fail("operator_credentials_required")
    return session.client("lambda", region_name="ap-northeast-1", endpoint_url="https://lambda.ap-northeast-1.amazonaws.com",
                          config=Config(connect_timeout=10, read_timeout=330, retries={"total_max_attempts": 1, "mode": "standard"}))


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        _fail("invalid_arguments")


def cli(argv=None):
    try:
        parser = _Parser(description=__doc__)
        for name in ["input", "output", "target"]:
            parser.add_argument("--" + name, type=Path, required=True)
        parser.add_argument("--execute", action="store_true")
        args = parser.parse_args(argv)
        if args.execute:
            prepare_remote(args.input, args.output, args.target)
            with closing(_lambda_client()) as client:
                result = prepare_remote(args.input, args.output, args.target, execute=True, client=client)
        else:
            result = prepare_remote(args.input, args.output, args.target)
        print(json.dumps(result))
        return 0
    except Exception as error:
        allowed = {"invalid_arguments", "invalid_target", "invalid_manifest", "invalid_private_input", "private_path_required", "private_input_required",
                   "workload_federation_required", "operator_credentials_required", "output_exists", "output_locked", "runtime_mismatch", "runtime_inspection_failed",
                   "remote_invocation_failed", "invalid_remote_result", "request_too_large", "output_write_failed"}
        code = str(error) if isinstance(error, EvaluationError) and str(error) in allowed else "evaluation_failed"
        print(json.dumps({"status": "failed", "code": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(cli())
