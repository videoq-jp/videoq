"""Promote versioned maintenance artifacts inside AWS, without reading DB secrets."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

REGION = "ap-northeast-1"
ACCOUNT = "257240362763"
BUCKET = "videoq-db-maintenance-prod-257240362763"
MACHINE = f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:videoq-db-maintenance-prod"
PURPOSES = ["rotation", "migration", "backup", "smoke", "audit"]
STARTERS = ["maintenance", "migration", "backup", "smoke", "deploy"]


def aws(service, command, **payload):
    with tempfile.TemporaryDirectory(prefix="videoq-maintenance-deploy-") as directory:
        args = ["aws", service, command, "--region", REGION,
                "--cli-connect-timeout", "10", "--cli-read-timeout", "70", "--cli-binary-format", "base64", "--output", "json"]
        if service == "lambda" and command == "invoke":
            # Streaming CLI commands do not accept --cli-input-json. Pass the
            # exact event bytes through fileb:// and provide the positional outfile.
            request, response = Path(directory) / "event.json", Path(directory) / "response.json"
            request.write_bytes(base64.b64decode(payload["Payload"], validate=True))
            request.chmod(0o600)
            args.extend(["--function-name", payload["FunctionName"], "--qualifier", payload["Qualifier"],
                         "--invocation-type", "RequestResponse", "--payload", "fileb://" + str(request), str(response)])
        else:
            body = payload.pop("Body", None) if service == "s3api" else None
            request = Path(directory) / "request.json"
            request.write_text(json.dumps(payload))
            request.chmod(0o600)
            args.extend(["--cli-input-json", "file://" + str(request)])
            if body is not None:
                args.extend(["--body", body])
        result = subprocess.run(args, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("DEPLOYMENT_AWS_REQUEST_FAILED")
        data = json.loads(result.stdout or "{}")
        if service == "lambda" and command == "invoke":
            if data.get("FunctionError"):
                raise RuntimeError("DEPLOYMENT_CANARY_FAILED")
            return json.loads(response.read_text())
        return data


def promote(directory, source, api=aws, sleep=time.sleep):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    if not re.fullmatch(r"[a-f0-9]{40}", source) or manifest["source_commit"] != source or manifest["dirty"]:
        raise RuntimeError("UNREVIEWED_DEPLOYMENT_BUNDLE")
    for name in ["operator", "broker"]:
        if hashlib.sha256((directory / (name + ".zip")).read_bytes()).hexdigest() != manifest[name + "_sha256"]:
            raise RuntimeError("DEPLOYMENT_BUNDLE_HASH_MISMATCH")
    definition = (directory / "state-machine.json").read_text()
    if hashlib.sha256(definition.encode()).hexdigest() != manifest["state_machine_sha256"]:
        raise RuntimeError("DEPLOYMENT_DEFINITION_HASH_MISMATCH")
    validated = api("stepfunctions", "validate-state-machine-definition", definition=definition, type="STANDARD")
    if validated["result"] != "OK":
        raise RuntimeError("INVALID_DEPLOYMENT_STATE_MACHINE")
    old_definition = api("stepfunctions", "describe-state-machine", stateMachineArn=MACHINE)["definition"]
    projects, aliases, candidates = {}, {}, {}
    expected_hash = base64.b64encode(bytes.fromhex(manifest["broker_sha256"])).decode()
    # Gather and validate ALL previous targets before changing any live reference.
    for purpose in PURPOSES:
        name = f"videoq-db-{purpose}-prod"
        rows = api("codebuild", "batch-get-projects", names=[name])["projects"]
        if len(rows) != 1 or rows[0]["source"]["type"] != "S3" or rows[0]["source"]["location"] != BUCKET + "/operator.zip":
            raise RuntimeError("UNEXPECTED_DEPLOYMENT_PROJECT")
        if rows[0]["serviceRole"] != f"arn:aws:iam::{ACCOUNT}:role/{name}":
            raise RuntimeError("UNEXPECTED_DEPLOYMENT_ROLE")
        projects[name] = rows[0]
    for purpose in STARTERS:
        name = f"videoq-db-start-{purpose}-prod"
        alias = api("lambda", "get-alias", FunctionName=name, Name="live")
        if not alias["FunctionVersion"].isdigit():
            raise RuntimeError("UNVERSIONED_DEPLOYMENT_ALIAS")
        aliases[name] = alias
    versions = {}
    for name in ["operator", "broker"]:
        uploaded = api("s3api", "put-object", Bucket=BUCKET, Key=name + ".zip",
                       Body=str(directory / (name + ".zip")), ServerSideEncryption="AES256")
        if not uploaded.get("VersionId") or uploaded["VersionId"] == "null":
            raise RuntimeError("UNVERSIONED_DEPLOYMENT_ARTIFACT")
        versions[name] = uploaded["VersionId"]
    # Publish and test immutable candidates BEFORE changing any live alias.
    for name in aliases:
        updated = api("lambda", "update-function-code", FunctionName=name, S3Bucket=BUCKET,
                      S3Key="broker.zip", S3ObjectVersion=versions["broker"], Publish=True)
        version = updated["Version"]
        if not version.isdigit() or updated["CodeSha256"] != expected_hash:
            raise RuntimeError("DEPLOYMENT_CODE_HASH_MISMATCH")
        for attempt in range(60):
            config = api("lambda", "get-function-configuration", FunctionName=name, Qualifier=version)
            if config.get("State") == "Active" and config.get("LastUpdateStatus", "Successful") == "Successful":
                break
            if config.get("State") == "Failed" or config.get("LastUpdateStatus") == "Failed":
                raise RuntimeError("DEPLOYMENT_CANDIDATE_FAILED")
            sleep(2)
        else:
            raise RuntimeError("DEPLOYMENT_CANDIDATE_TIMEOUT")
        # Invalid operations and arbitrary build overrides must have no side effects.
        for payload, reason in [({"action": "start", "kind": "invalid"}, "OPERATION_NOT_ALLOWED"),
                                ({"action": "start", "kind": "rotate", "buildspecOverride": "untrusted"}, "UNEXPECTED_INPUT")]:
            result = api("lambda", "invoke", FunctionName=name, Qualifier=version,
                         Payload=base64.b64encode(json.dumps(payload).encode()).decode())
            if result != {"status": "REJECTED", "reason": reason}:
                raise RuntimeError("DEPLOYMENT_CANARY_FAILED")
        candidates[name] = version
    changed_projects, changed_aliases, state_changed = [], [], False
    try:
        for name, previous in projects.items():
            changed_projects.append(name)  # Include a request whose response may be lost.
            tags = [x for x in previous.get("tags", []) if x["key"] != "ReviewedSource"]
            api("codebuild", "update-project", name=name, sourceVersion=versions["operator"],
                tags=tags + [{"key": "ReviewedSource", "value": source}])
        state_changed = True
        api("stepfunctions", "update-state-machine", stateMachineArn=MACHINE, definition=definition)
        for name, previous in aliases.items():
            changed_aliases.append(name)
            api("lambda", "update-alias", FunctionName=name, Name="live", FunctionVersion=candidates[name],
                RevisionId=previous["RevisionId"])
        for name, version in candidates.items():
            if api("lambda", "get-alias", FunctionName=name, Name="live")["FunctionVersion"] != version:
                raise RuntimeError("DEPLOYMENT_ALIAS_VERIFICATION_FAILED")
        for name in projects:
            row = api("codebuild", "batch-get-projects", names=[name])["projects"][0]
            if row["sourceVersion"] != versions["operator"]:
                raise RuntimeError("DEPLOYMENT_SOURCE_VERIFICATION_FAILED")
        actual = api("stepfunctions", "describe-state-machine", stateMachineArn=MACHINE)["definition"]
        if json.loads(actual) != json.loads(definition):
            raise RuntimeError("DEPLOYMENT_DEFINITION_VERIFICATION_FAILED")
    except Exception:
        rollback_failed = False
        for name in reversed(changed_aliases):
            try:
                current = api("lambda", "get-alias", FunctionName=name, Name="live")
                if current["FunctionVersion"] == candidates[name]:
                    api("lambda", "update-alias", FunctionName=name, Name="live", FunctionVersion=aliases[name]["FunctionVersion"], RevisionId=current["RevisionId"])
                elif current["FunctionVersion"] != aliases[name]["FunctionVersion"]:
                    rollback_failed = True
            except Exception:
                rollback_failed = True
        if state_changed:
            try:
                api("stepfunctions", "update-state-machine", stateMachineArn=MACHINE, definition=old_definition)
            except Exception:
                rollback_failed = True
        for name in reversed(changed_projects):
            try:
                api("codebuild", "update-project", name=name, sourceVersion=projects[name]["sourceVersion"], tags=projects[name].get("tags", []))
            except Exception:
                rollback_failed = True
        raise RuntimeError("DEPLOYMENT_ROLLBACK_INCOMPLETE" if rollback_failed else "DEPLOYMENT_REVERTED") from None
    print(json.dumps({"status": "deployed", "source_commit": source, "starters": len(candidates), "projects": len(projects)}))


def main():
    if not re.fullmatch(r"arn:aws:codebuild:ap-northeast-1:257240362763:build/videoq-db-deploy-prod:[a-f0-9-]{36}", os.environ.get("CODEBUILD_BUILD_ARN", "")):
        raise RuntimeError("AWS_DEPLOYMENT_BUILD_REQUIRED")
    source = os.environ.get("MAINTENANCE_SOURCE_SHA", "")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    main_sha = subprocess.check_output(["git", "ls-remote", "origin", "refs/heads/main"], text=True).split()[0]
    if source != actual or source != main_sha:
        raise RuntimeError("STALE_DEPLOYMENT_SOURCE")
    promote("/tmp/videoq-db-bundles", source)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        reason = str(error)
        print("Maintenance deployment stopped: " + (reason if re.fullmatch(r"[A-Z][A-Z0-9_]+", reason) else "DEPLOYMENT_FAILED"))
        raise SystemExit(1)
