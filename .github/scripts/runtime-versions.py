"""Update non-image runtime pins without executing downloaded package code.

The JSON manifest is authoritative. Generated pins are committed and checked in
CI. Current-line proposals can be merged by the trusted runtime workflow after CI.
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ".github/runtime-versions.json"
NODE_INDEX = "https://nodejs.org/dist/index.json"
PYTHON_INDEX = "https://www.python.org/api/v2/downloads/release/?is_published=true"
_spec = importlib.util.spec_from_file_location("package_managers", Path(__file__).with_name("package-managers.py"))
managers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(managers)
NODE_FILES = (
    "apps/api/Dockerfile", "apps/api/Dockerfile.local",
    "apps/web/Dockerfile.dev", "apps/web/Dockerfile",
)


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


def validate(data):
    version(data["node"])
    version(data["python"])
    if set(data) - {"node", "python", "python_minimum", "npm", "pip", "uv", "tool_downloads"}:
        raise ValueError("Unknown runtime manifest field")
    if not re.fullmatch(r"3\.\d+", data["python_minimum"]):
        raise ValueError("Invalid minimum Python series")
    if version(data["python"])[:2] < tuple(map(int, data["python_minimum"].split("."))):
        raise ValueError("Python cannot be older than the supported minimum")
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
    for path in NODE_FILES:
        if (root / path).exists():
            text = (root / path).read_text()
            files[path] = text
            files[path] = managed_block(files[path], managers.docker_block(data, "npm"), "npm", r"(?m)^FROM node:[^\n]+\n")
    for path in ["apps/worker/Dockerfile", "apps/worker/Dockerfile.local", "apps/worker/Dockerfile.onprem"]:
        if (root / path).exists():
            text = (root / path).read_text()
            files[path] = text
            files[path] = re.sub(r"(?m)^ARG PYTHON_VERSION=\S+", "ARG PYTHON_VERSION=" + data["python"], files[path])
            files[path] = managed_block(files[path], managers.docker_block(data, "pip"), "pip", r"(?m)^FROM (?:public\.ecr\.aws/lambda/python|python):[^\n]+\n")
    return files


def declared_tools(root):
    folder = root / ".github/runtime-tools"
    package = json.loads((folder / "package.json").read_text())
    tools = {"npm": package["dependencies"]["npm"]}
    for line in (folder / "requirements.txt").read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"(pip|uv)==(\d+\.\d+\.\d+)", line)
        if not match or match[1] in tools:
            raise ValueError("Expected unique exact pip and uv bootstrap pins")
        tools[match[1]] = match[2]
    if set(tools) != {"npm", "pip", "uv"}:
        raise ValueError("Missing bootstrap tool pin")
    for value in tools.values():
        version(value)
    return tools


def discover(root, data, runtime, upgrade):
    data = copy.deepcopy(data)
    previous = data[runtime]
    if runtime in {"npm", "pip", "uv"}:
        candidate = declared_tools(root)[runtime]
        selected = managers.newer(previous, runtime, upgrade, [candidate])
        if selected == previous:
            return data
        data = managers.resolve(data, runtime, selected, request)
    else:
        data[runtime] = latest(previous, runtime, upgrade, request(NODE_INDEX if runtime == "node" else PYTHON_INDEX))
    if upgrade and data[runtime] == previous:
        return data
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
        declared_tools(ROOT)
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
