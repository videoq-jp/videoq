"""Request a fixed AWS database operation and observe metadata only; no DB credentials."""
import argparse
import json
import os
import re
import secrets
import subprocess
import tempfile
import time
from pathlib import Path

FUNCTIONS = {kind: "maintenance" for kind in ["rotate", "rollback", "audit"]}
FUNCTIONS.update({kind: kind for kind in ["migration", "backup", "smoke", "deploy"]})
FUNCTIONS["cutover-hold"] = "maintenance"
CUTOVER_ACTIONS = {"release-cutover-hold", "recover-cutover-hold", "prepare-cutover-consumers", "pause-cutover-consumers", "resume-cutover-consumers", "retry-cutover-consumers", "inspect-cutover-activity", "retry-cutover-activity"}


def invocation(function, payload):
    with tempfile.TemporaryDirectory(prefix="videoq-db-request-") as directory:
        request, response = Path(directory) / "request.json", Path(directory) / "response.json"
        request.write_text(json.dumps(payload))
        request.chmod(0o600)
        result = subprocess.run([
            "aws", "lambda", "invoke", "--region", "ap-northeast-1", "--function-name", function,
            "--invocation-type", "RequestResponse", "--cli-binary-format", "raw-in-base64-out",
            "--payload", "file://" + str(request), "--cli-connect-timeout", "10", "--cli-read-timeout", "70",
            "--output", "json", str(response),
        ], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("AWS_REQUEST_UNAVAILABLE")
        metadata = json.loads(result.stdout)
        if metadata.get("StatusCode") != 200 or metadata.get("FunctionError"):
            raise RuntimeError("AWS_REQUEST_UNAVAILABLE")
        return json.loads(response.read_text())


def run(kind, request, invoke=invocation, sleep=time.sleep, now=time.monotonic):
    function = "arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-db-start-" + FUNCTIONS[kind] + "-prod:live"
    request = {"action": "start", "kind": kind, "client_token": secrets.token_hex(16), **request}
    deadline, previous, errors, run_id = now() + 115 * 60, None, 0, None
    while now() < deadline:
        payload = {"action": "status", "run_id": run_id} if run_id else request
        try:
            result = invoke(function, payload)
        except (RuntimeError, ValueError, OSError):
            errors += 1
            if errors >= 5:
                raise RuntimeError("AWS_EXECUTION_OBSERVATION_FAILED") from None
            # Re-poll the same run, or retry the same idempotent start token.
            sleep(15)
            continue
        errors = 0
        state = result.get("status")
        if "run_id" in result:
            if not re.fullmatch(r"[a-f0-9]{32}", result["run_id"]):
                raise RuntimeError("INVALID_AWS_RUN_ID")
            if run_id and run_id != result["run_id"]:
                raise RuntimeError("AWS_EXECUTION_CHANGED")
            run_id = result["run_id"]
        if state != previous:
            if state not in {"RUNNING", "BUSY", "SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED", "PENDING_REDRIVE", "REJECTED", "RECOVERED"}:
                raise RuntimeError("INVALID_AWS_EXECUTION_STATE")
            print("AWS database " + kind + ": " + state + (" (" + run_id + ")" if run_id else ""), flush=True)
            previous = state
        if kind == "cutover-hold" and state in {"SUCCEEDED", "RECOVERED"}:
            raise RuntimeError("CUTOVER_HOLD_ALREADY_RELEASED")
        if kind == "cutover-hold" and state == "RUNNING":
            if not run_id:
                raise RuntimeError("MISSING_AWS_RUN_ID")
            return run_id
        if state == "SUCCEEDED":
            if not run_id:
                raise RuntimeError("MISSING_AWS_RUN_ID")
            return run_id
        if state == "REJECTED":
            reason = result.get("reason", "AWS_REQUEST_REJECTED")
            raise RuntimeError(reason if re.fullmatch(r"[A-Z][A-Z0-9_]+", reason) else "AWS_REQUEST_REJECTED")
        if state in {"FAILED", "TIMED_OUT", "ABORTED"}:
            raise RuntimeError("CUTOVER_RECOVERY_REQUIRED" if kind == "cutover-hold" else "AWS_DATABASE_OPERATION_FAILED")
        sleep(15)
    raise RuntimeError("AWS_EXECUTION_OBSERVATION_TIMEOUT")


def control_cutover(action, run_id, invoke=invocation, sleep=time.sleep, now=time.monotonic):
    if action not in CUTOVER_ACTIONS or not re.fullmatch(r"[a-f0-9]{32}", run_id or ""):
        raise RuntimeError("INVALID_CUTOVER_CONTROL")
    function = "arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-db-start-maintenance-prod:live"
    payload = {"action": action, "run_id": run_id}
    deadline, errors, previous = now() + 115 * 60, 0, None
    while now() < deadline:
        try:
            result = invoke(function, payload)
        except (RuntimeError, ValueError, OSError):
            errors += 1
            if errors >= 5:
                raise RuntimeError("AWS_EXECUTION_OBSERVATION_FAILED") from None
            sleep(15)
            continue
        errors = 0
        state = result.get("status")
        if state != "REJECTED" and result.get("run_id") != run_id:
            raise RuntimeError("AWS_EXECUTION_CHANGED")
        if state == "REJECTED":
            reason = result.get("reason", "AWS_REQUEST_REJECTED")
            raise RuntimeError(reason if re.fullmatch(r"[A-Z][A-Z0-9_]+", reason) else "AWS_REQUEST_REJECTED")
        if state not in {"RUNNING", "SUCCEEDED", "RECOVERED", "FAILED", "TIMED_OUT", "ABORTED", "PENDING_REDRIVE"}:
            raise RuntimeError("INVALID_AWS_EXECUTION_STATE")
        if state != previous:
            print("AWS cutover hold: " + state + " (" + run_id + ")", flush=True)
            previous = state
        ready_flag = {"prepare-cutover-consumers": "consumer_prepared", "pause-cutover-consumers": "consumers_paused", "resume-cutover-consumers": "consumers_restored", "retry-cutover-consumers": "consumer_retry_accepted", "inspect-cutover-activity": "activity_observed", "retry-cutover-activity": "activity_retry_accepted"}.get(action)
        if ready_flag and state == "RUNNING" and result.get(ready_flag) is True:
            return run_id
        if (state == "RECOVERED" and action in {"release-cutover-hold", "recover-cutover-hold"}) or (state == "SUCCEEDED" and action == "release-cutover-hold"):
            return run_id
        if state in {"FAILED", "TIMED_OUT", "ABORTED"}:
            raise RuntimeError("CUTOVER_RECOVERY_REQUIRED")
        if state != "RUNNING" or action == "recover-cutover-hold":
            raise RuntimeError("INVALID_AWS_EXECUTION_STATE")
        payload = {"action": "status", "run_id": run_id}
        sleep(15)
    raise RuntimeError("AWS_EXECUTION_OBSERVATION_TIMEOUT")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=[*FUNCTIONS, *sorted(CUTOVER_ACTIONS)])
    parser.add_argument("--run-id")
    parser.add_argument("--inspection", choices=["postgres-login-fence"])
    args = parser.parse_args()
    if os.environ.get("GITHUB_REPOSITORY") != "videoq-jp/videoq" or os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise RuntimeError("PRODUCTION_MAIN_ONLY")
    if args.kind in CUTOVER_ACTIONS:
        if args.inspection:
            raise RuntimeError("INVALID_AUDIT_INSPECTION")
        control_cutover(args.kind, args.run_id)
        return
    if args.run_id:
        raise RuntimeError("UNEXPECTED_RUN_ID")
    if args.inspection and args.kind != "audit":
        raise RuntimeError("INVALID_AUDIT_INSPECTION")
    request = {"inspection": args.inspection} if args.inspection else {}
    if args.kind in {"migration", "deploy", "cutover-hold"}:
        sha = os.environ.get("GITHUB_SHA", "")
        if not re.fullmatch(r"[a-f0-9]{40}", sha):
            raise RuntimeError("INVALID_MIGRATION_SOURCE")
        request = {"source_sha": sha}
    if args.kind == "migration":
        writers = os.environ.get("STRUCTURED_ANSWER_WRITERS_STOPPED", "")
        if writers not in {"", "0", "1"}:
            raise RuntimeError("INVALID_WRITER_STATE")
        request = {"source_sha": sha, "writers_stopped": writers == "1"}
    if args.kind == "rotate":
        value = os.environ.get("FORCE_ROTATION", "false")
        if value not in {"true", "false"}:
            raise RuntimeError("INVALID_FORCE_ROTATION")
        request["force"] = value == "true"
    if args.kind == "smoke":
        request["verify_ai_answers"] = os.environ.get("VERIFY_AI_ANSWERS") == "true"
    run_id = run(args.kind, request)
    if args.kind in {"smoke", "backup"}:
        summary = {"smoke": "AWS内で本番の処理・ブラウザー確認が成功しました。", "backup": "AWS内で読み取り専用バックアップの復元確認が成功しました。"}[args.kind]
        Path("operations-report.json").write_text(json.dumps({"status": "ok", "summary": summary, "details": ["- AWS実行ID: `" + run_id + "`"]}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        reason = str(error) if re.fullmatch(r"[A-Z][A-Z0-9_]+", str(error)) else "AWS_MAINTENANCE_REQUEST_FAILED"
        raise SystemExit("Database operation stopped: " + reason) from None
