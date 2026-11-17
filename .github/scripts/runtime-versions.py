"""Coordinate interpreter versions without executing downloaded package code.

The JSON manifest is authoritative. Generated pins are committed and checked in
CI. Current-line proposals can be merged by the trusted runtime workflow after CI.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ".github/runtime-versions.json"
NODE_INDEX = "https://nodejs.org/dist/index.json"
PYTHON_INDEX = "https://www.python.org/api/v2/downloads/release/?is_published=true"
_spec = importlib.util.spec_from_file_location("package_managers", Path(__file__).with_name("package-managers.py"))
managers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(managers)
NODE_FILES = {
    "apps/api/Dockerfile": "node_onprem",
    "apps/api/Dockerfile.local": "node_bookworm",
    "apps/web/Dockerfile.dev": "node_bookworm",
    "apps/web/Dockerfile": "node_alpine",
}


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise ValueError("An exact, stable interpreter version is required")
    return tuple(map(int, value.split(".")))


def request(url, headers=None, raw=False):
    headers = {"User-Agent": "videoq-runtime-updates", **(headers or {})}
    # The optional read-only Actions token is sent only to GitHub's API.
    if urllib.parse.urlparse(url).netloc == "api.github.com" and os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=45) as response:
        body = response.read()
    return body if raw else json.loads(body)


class MissingImage(ValueError):
    """The registry confirms that an otherwise valid image tag is not published."""


def image_digest(name, tag):
    # Fixed registry/repository pairs prevent URL substrings from selecting a host.
    locations = {
        "node": ("registry-1.docker.io", "library/node"),
        "python": ("registry-1.docker.io", "library/python"),
        "public.ecr.aws/lambda/python": ("public.ecr.aws", "lambda/python"),
        "ghcr.io/astral-sh/uv": ("ghcr.io", "astral-sh/uv"),
    }
    if name not in locations:
        raise ValueError("Unsupported runtime image repository")
    registry, repository = locations[name]
    if registry == "public.ecr.aws":
        token_url = "https://public.ecr.aws/token/?service=public.ecr.aws&scope=repository:lambda/python:pull"
    elif registry == "ghcr.io":
        token_url = "https://ghcr.io/token?service=ghcr.io&scope=repository:astral-sh/uv:pull"
    else:
        token_url = "https://auth.docker.io/token?service=registry.docker.io&scope=repository:" + repository + ":pull"
    token = request(token_url)["token"]
    url = f"https://{registry}/v2/{repository}/manifests/{tag}"
    try:
        body = request(url, {
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json",
        }, raw=True)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            try:
                errors = json.loads(error.read()).get("errors", [])
            except (ValueError, AttributeError):
                errors = []
            if isinstance(errors, list) and errors and all(isinstance(item, dict) and item.get("code") == "MANIFEST_UNKNOWN" for item in errors):
                raise MissingImage(f"Not yet published: {url}") from error
        raise
    platforms = {m.get("platform", {}).get("architecture") for m in json.loads(body).get("manifests", [])}
    if not {"amd64", "arm64"}.issubset(platforms):
        raise ValueError(f"{name}:{tag} must publish both amd64 and arm64 images")
    return f"{name}:{tag}@sha256:{hashlib.sha256(body).hexdigest()}"


def candidates(current, runtime, upgrade, releases):
    current_version = version(current)
    candidates = []
    for release in releases:
        if runtime == "node":
            candidate = release["version"].removeprefix("v")
            if not re.fullmatch(r"\d+\.\d+\.\d+", candidate):
                continue
            parsed = version(candidate)
            if upgrade:
                if parsed[0] <= current_version[0] or not release.get("lts"):
                    continue
            elif parsed[0] != current_version[0]:
                continue
        else:
            candidate = release.get("name", "").removeprefix("Python ")
            if release.get("pre_release") or not release.get("is_published") or not re.fullmatch(r"3\.\d+\.\d+", candidate):
                continue
            parsed = version(candidate)
            if (parsed[:2] <= current_version[:2]) if upgrade else (parsed[:2] != current_version[:2]):
                continue
        if parsed > current_version:
            candidates.append(parsed)
    return [".".join(map(str, parsed)) for parsed in sorted(set(candidates), reverse=True)]


def latest(current, runtime, upgrade, releases):
    return next(iter(candidates(current, runtime, upgrade, releases)), current)


def python_images(python):
    return {
        "python_local": image_digest("python", python + "-slim-bookworm"),
        "python_onprem": image_digest("python", python + "-slim-bookworm"),
        "python_lambda": image_digest("public.ecr.aws/lambda/python", ".".join(python.split(".")[:2])),
    }


def discover_python(root, data, upgrade):
    previous = data["python"]
    releases = candidates(previous, "python", upgrade, request(PYTHON_INDEX))
    needs_images = bool(data.get("images")) or (root / "apps/web/Dockerfile").exists()
    for candidate in releases:
        try:
            images = python_images(candidate) if needs_images else {}
        except MissingImage as error:
            print(f"Deferring Python {candidate}: {error}", file=sys.stderr)
            continue
        data["python"] = candidate
        if needs_images:
            data.setdefault("images", {}).update(images)
        validate(data)
        return data
    # Current-channel runs still refresh digests. A missing already-pinned image
    # is a real failure, not publication lag for a proposed interpreter release.
    if not upgrade and needs_images:
        data.setdefault("images", {}).update(python_images(previous))
    validate(data)
    return data


def validate(data):
    version(data["node"])
    version(data["python"])
    if set(data) - {"node", "python", "python_minimum", "images", "npm", "pip", "uv", "tool_downloads"}:
        raise ValueError("Unknown runtime manifest field")
    if not re.fullmatch(r"3\.\d+", data["python_minimum"]):
        raise ValueError("Invalid minimum Python series")
    if version(data["python"])[:2] < tuple(map(int, data["python_minimum"].split("."))):
        raise ValueError("Python cannot be older than the supported minimum")
    for image in data.get("images", {}).values():
        if not re.fullmatch(r"(?:node|python|public\.ecr\.aws/lambda/python|ghcr\.io/astral-sh/uv):[\w.-]+@sha256:[a-f0-9]{64}", image):
            raise ValueError("Interpreter images must use an immutable digest")
    if data.get("images"):
        expected = {
            "node_bookworm": "node:" + data["node"] + "-bookworm-slim@",
            "node_alpine": "node:" + data["node"] + "-alpine@",
            "node_onprem": "node:" + data["node"] + "-alpine@",
            "python_local": "python:" + data["python"] + "-slim-bookworm@",
            "python_onprem": "python:" + data["python"] + "-slim-bookworm@",
            "python_lambda": "public.ecr.aws/lambda/python:" + ".".join(data["python"].split(".")[:2]) + "@",
            "uv": "ghcr.io/astral-sh/uv:" + data["uv"] + "@",
        }
        if set(data["images"]) != set(expected) or any(not data["images"][key].startswith(prefix) for key, prefix in expected.items()):
            raise ValueError("Container interpreters and tools must match the canonical version pins")
    managers.validate(data)


def managed_block(text, block, manager, after=None):
    pattern = r"(?ms)^# BEGIN managed " + manager + r"\n.*?^# END managed " + manager
    if re.search(pattern, text):
        return re.sub(pattern, lambda _: block, text)
    if after:
        return re.sub(after, lambda match: match.group(0) + "\n" + block + "\n", text, count=1)
    return text.rstrip() + "\n\n" + block + "\n"


def rendered(root, data):
    validate(data)
    files = {".node-version": data["node"] + "\n", ".nvmrc": data["node"] + "\n", ".python-version": data["python"] + "\n"}
    package = json.loads((root / "package.json").read_text())
    package["packageManager"] = "npm@" + data["npm"]
    files["package.json"] = json.dumps(package, indent=2, ensure_ascii=False) + "\n"
    images = data.get("images", {})
    for path, key in NODE_FILES.items():
        if (root / path).exists():
            text = (root / path).read_text()
            files[path], count = re.subn(r"(?m)^FROM node:\S+", "FROM " + images[key], text)
            if count != 1:
                raise ValueError(f"Expected one Node image in {path}")
            files[path] = managed_block(files[path], managers.docker_block(data, "npm"), "npm", r"(?m)^FROM node:[^\n]+\n")
    for path, key in [("apps/worker/Dockerfile", "python_lambda"), ("apps/worker/Dockerfile.local", "python_local"), ("apps/worker/Dockerfile.onprem", "python_onprem")]:
        if (root / path).exists():
            text = (root / path).read_text()
            files[path], count = re.subn(r"(?m)^FROM (?:public\.ecr\.aws/lambda/python|python):\S+", "FROM " + images[key], text)
            if count != 1:
                raise ValueError(f"Expected one Python image in {path}")
            files[path] = re.sub(r"(?m)^ARG PYTHON_VERSION=\S+", "ARG PYTHON_VERSION=" + data["python"], files[path])
            files[path] = managed_block(files[path], managers.docker_block(data, "pip"), "pip", r"(?m)^FROM (?:public\.ecr\.aws/lambda/python|python):[^\n]+\n")
            if path in {"apps/worker/Dockerfile", "apps/worker/Dockerfile.onprem"}:
                files[path] = re.sub(r"(?m)^FROM ghcr.io/astral-sh/uv:\S+", "FROM " + images["uv"], files[path])
    return files


def discover(root, data, runtime, upgrade):
    data = copy.deepcopy(data)
    if runtime == "python":
        return discover_python(root, data, upgrade)
    previous = data[runtime]
    if runtime in {"npm", "pip", "uv"}:
        data = managers.discover(data, runtime, upgrade, request)
    else:
        data[runtime] = latest(previous, runtime, upgrade, request(NODE_INDEX if runtime == "node" else PYTHON_INDEX))
    if upgrade and data[runtime] == previous:
        return data
    if data.get("images") or (root / "apps/web/Dockerfile").exists():
        images = data.setdefault("images", {})
        if runtime == "node":
            images["node_bookworm"] = image_digest("node", data["node"] + "-bookworm-slim")
            images["node_alpine"] = image_digest("node", data["node"] + "-alpine")
            images["node_onprem"] = image_digest("node", data["node"] + "-alpine")
        elif runtime == "uv":
            images["uv"] = image_digest("ghcr.io/astral-sh/uv", data["uv"])
    validate(data)
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "sync", "matrix", "plan"])
    parser.add_argument("--runtime", choices=["node", "python", "npm", "pip", "uv"])
    parser.add_argument("--upgrade", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    data = json.loads((ROOT / MANIFEST).read_text())
    if args.command == "matrix":
        validate(data)
        rows = [{"python": data["python_minimum"], "production": False, "runner": "ubuntu-latest"}, {"python": data["python"], "production": True, "runner": "ubuntu-24.04-arm"}]
        print("matrix=" + json.dumps({"include": rows}, separators=(",", ":")))
        return
    if args.command == "plan":
        if not args.runtime or not args.output:
            parser.error("plan requires --runtime and --output")
        previous_version = data[args.runtime]
        data = discover(ROOT, data, args.runtime, args.upgrade)
    files = rendered(ROOT, data)
    files[MANIFEST] = json.dumps(data, indent=2) + "\n"
    changed = {path: text for path, text in files.items() if not (ROOT / path).exists() or (ROOT / path).read_text() != text}
    if args.command == "check":
        if changed:
            raise ValueError("Runtime pins differ from the manifest: " + ", ".join(changed) + "; run python3 .github/scripts/runtime-versions.py sync")
        for path in (ROOT / ".github/workflows").glob("*.yml"):
            if re.search(r"(?m)^\s+(?:node|python)-version:\s*['\"]?\d", path.read_text()):
                raise ValueError(f"{path.name}: use the canonical version files, or the tested compatibility matrix")
        print("Runtime versions and generated interpreter pins are consistent")
    elif args.command == "sync":
        for path, text in changed.items():
            (ROOT / path).write_text(text)
        print("Synchronized " + str(len(changed)) + " runtime files")
    else:
        plan = {"changed": bool(changed), "runtime": args.runtime, "channel": "next" if args.upgrade else "current", "version": data[args.runtime], "previous_version": previous_version, "files": changed}
        args.output.write_text(json.dumps(plan, indent=2) + "\n")
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with open(output, "a") as stream:
                stream.write("changed=" + str(bool(changed)).lower() + "\n")
        print(f"{args.runtime} {data[args.runtime]}: {len(changed)} proposed file changes")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError) as error:
        sys.exit(str(error))
