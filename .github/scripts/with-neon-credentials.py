"""Read the production Neon SecureString and pass it only to the requested command."""

import json
import os
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit, parse_qs
from pathlib import Path


def main():
    if len(sys.argv) < 3:
        raise SystemExit("A database command is required")
    purpose = sys.argv[1]
    profiles = json.loads(Path(__file__).with_name("neon-profiles.json").read_text())
    if purpose not in {"migration", "backup", "audit", "smoke", "demo"}:
        raise SystemExit("Unknown database purpose")
    result = subprocess.run(
        ["aws", "ssm", "get-parameter", "--region", "ap-northeast-1",
         "--name", profiles[purpose]["parameter"], "--with-decryption",
         "--output", "json"],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise SystemExit("Unable to read the Neon SSM parameter")
    try:
        parameter = json.loads(result.stdout)["Parameter"]
        if parameter["Type"] != "SecureString":
            raise ValueError()
        url = json.loads(parameter["Value"])["DATABASE_URL"]
        if not isinstance(url, str):
            raise ValueError()
        parsed = urlsplit(url)
        if (parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname
                or not parsed.password or any(c in url for c in "\r\n")
                or parse_qs(parsed.query).get("sslmode") != ["verify-full"]):
            raise ValueError()
        user = unquote(parsed.username or "")
        prefix = "(?:migration|migrate)" if purpose == "migration" else purpose
        if not re.fullmatch(r"videoq_" + prefix + r"_[A-Za-z0-9_]+", user):
            raise ValueError()
        if purpose == "migration" and user != profiles[purpose]["access"]:
            if parse_qs(parsed.query).get("options") != ["-c role=" + profiles[purpose]["access"]]:
                raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise SystemExit("Invalid Neon SecureString; expected JSON with DATABASE_URL") from None
    if os.environ.get("GITHUB_ACTIONS") == "true":
        for value in dict.fromkeys([url, parsed.password, unquote(parsed.password)]):
            escaped = value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print(f"::add-mask::{escaped}", flush=True)
    env = os.environ.copy()
    env["DATABASE_URL"] = url
    # Database commands do not need the AWS credentials or GitHub OIDC endpoint.
    for key in list(env):
        if key.startswith("AWS_") or key.startswith("ACTIONS_ID_TOKEN_"):
            del env[key]
    return subprocess.run(sys.argv[2:], env=env).returncode


if __name__ == "__main__":
    sys.exit(main())
