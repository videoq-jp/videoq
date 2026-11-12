"""Fail closed unless the canonical on-prem package already exists and is public."""
import argparse
import json
import subprocess


def check_public(component):
    if component not in ("api", "worker", "web", "transcription-gateway"):
        raise ValueError("Unknown on-prem component")
    package = "videoq-" + component
    endpoint = "orgs/videoq-jp/packages/container/" + package
    result = subprocess.run(["gh", "api", endpoint], capture_output=True, text=True)
    try:
        package = json.loads(result.stdout)
    except (ValueError, TypeError) as error:
        raise RuntimeError("Cannot verify package visibility") from error
    if not isinstance(package, dict):
        raise RuntimeError("Unexpected package visibility response")
    if result.returncode:
        raise RuntimeError("Package visibility request failed")
    if package.get("visibility") != "public":
        raise RuntimeError("On-prem package must be public: " + component)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("component", choices=("api", "worker", "web", "transcription-gateway"))
    args = parser.parse_args()
    check_public(args.component)
