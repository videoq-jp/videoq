"""Discover and install npm/pip/uv only after checking committed distribution hashes."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import ssl
import http.client
import urllib.error
import urllib.request
import urllib.parse

TARGETS = {
    "linux-x86_64": "x86_64-unknown-linux-gnu",
    "linux-aarch64": "aarch64-unknown-linux-gnu",
    "darwin-x86_64": "x86_64-apple-darwin",
    "darwin-aarch64": "aarch64-apple-darwin",
}


def stable(value):
    return bool(isinstance(value, str) and re.fullmatch(r"\d+\.\d+\.\d+", value))


def validate(data):
    for name in ("npm", "pip", "uv"):
        if not stable(data[name]):
            raise ValueError(f"An exact stable {name} version is required")
    downloads = data["tool_downloads"]
    npm = downloads["npm"]
    if npm["url"] != f"https://registry.npmjs.org/npm/-/npm-{data['npm']}.tgz" or not re.fullmatch(r"sha512-[A-Za-z0-9+/]{86}==", npm["integrity"]):
        raise ValueError("npm must be a hash-pinned official distribution")
    pip = downloads["pip"]
    if not pip["url"].startswith("https://files.pythonhosted.org/packages/") or not pip["url"].endswith(f"/pip-{data['pip']}-py3-none-any.whl") or not re.fullmatch(r"[a-f0-9]{64}", pip["sha256"]):
        raise ValueError("pip must be a hash-pinned official wheel")
    if set(downloads["uv"]) != set(TARGETS):
        raise ValueError("uv must include both supported Linux and macOS architectures")
    for target, archive in downloads["uv"].items():
        expected = f"https://github.com/astral-sh/uv/releases/download/{data['uv']}/uv-{TARGETS[target]}.tar.gz"
        if archive["url"] != expected or not re.fullmatch(r"[a-f0-9]{64}", archive["sha256"]):
            raise ValueError("uv must use hash-pinned official release archives")


def newer(current, name, upgrade, candidates):
    parse = lambda v: tuple(map(int, v.split(".")))
    current_parts = parse(current)
    # uv is pre-1.0: a new minor is a new release line.
    width = 2 if name == "uv" and current_parts[0] == 0 else 1
    selected = []
    for candidate in candidates:
        if not stable(candidate):
            continue
        parts = parse(candidate)
        if parts <= current_parts:
            continue
        if (parts[:width] > current_parts[:width]) if upgrade else (parts[:width] == current_parts[:width]):
            selected.append(parts)
    return ".".join(map(str, max(selected))) if selected else current


def discover(data, name, upgrade, request):
    if name == "npm":
        releases = request("https://registry.npmjs.org/npm", {"Accept": "application/vnd.npm.install-v1+json"})["versions"]
        candidate = newer(data[name], name, upgrade, releases)
        metadata = releases[candidate]["dist"]
        download = {"url": metadata["tarball"], "integrity": metadata["integrity"]}
    elif name == "pip":
        releases = request("https://pypi.org/pypi/pip/json")["releases"]
        candidates = [v for v, files in releases.items() if files and not all(f.get("yanked") for f in files)]
        candidate = newer(data[name], name, upgrade, candidates)
        metadata = request(f"https://pypi.org/pypi/pip/{candidate}/json")
        wheel = next(f for f in metadata["urls"] if f["filename"] == f"pip-{candidate}-py3-none-any.whl" and not f.get("yanked"))
        download = {"url": wheel["url"], "sha256": wheel["digests"]["sha256"]}
    else:
        releases = request("https://api.github.com/repos/astral-sh/uv/releases?per_page=100")
        candidates = [r["tag_name"] for r in releases if not r["draft"] and not r["prerelease"]]
        candidate = newer(data[name], name, upgrade, candidates)
        metadata = request(f"https://api.github.com/repos/astral-sh/uv/releases/tags/{candidate}")
        download = {}
        for target, triple in TARGETS.items():
            asset = next(a for a in metadata["assets"] if a["name"] == f"uv-{triple}.tar.gz")
            digest = asset.get("digest", "")
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
                raise ValueError("Missing uv release archive digest")
            download[target] = {"url": asset["browser_download_url"], "sha256": digest[7:]}
    if not upgrade or candidate != data[name]:
        data[name] = candidate
        data["tool_downloads"][name] = download
    validate(data)
    return data


GITHUB_RELEASE_URL = re.compile(r"https://github\.com/([A-Za-z0-9_-][A-Za-z0-9_.-]*)/([A-Za-z0-9_-][A-Za-z0-9_.-]*)/releases/download/([A-Za-z0-9_.+-]+)/([A-Za-z0-9_.+-]+)")


def github_asset_api(url):
    match = GITHUB_RELEASE_URL.fullmatch(url)
    if not match:
        return None
    owner, repository, tag, name = match.groups()
    endpoint = f"https://api.github.com/repos/{owner}/{repository}/releases"
    request = urllib.request.Request(endpoint + "/tags/" + urllib.parse.quote(tag, safe=""), headers={"Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        metadata = response.read(2 * 1024 * 1024 + 1)
    if len(metadata) > 2 * 1024 * 1024:
        raise ValueError("GitHub release metadata exceeds the size limit")
    release = json.loads(metadata)
    assets = [asset for asset in release.get("assets", []) if asset.get("name") == name]
    if (release.get("tag_name") != tag or len(assets) != 1 or
            type(assets[0].get("id")) is not int or assets[0]["id"] <= 0):
        raise ValueError("Unexpected GitHub release tag or asset")
    request = urllib.request.Request(endpoint + f"/assets/{assets[0]['id']}", headers={"Accept": "application/octet-stream"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read(64 * 1024 * 1024 + 1)


def downloaded(url):
    # Public release assets can return transient gateway errors. Retry only
    # transport failures; integrity/size checks below still fail immediately.
    attempts = 2 if GITHUB_RELEASE_URL.fullmatch(url) else 4
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(url, timeout=30 if attempts == 2 else 60) as response:
                body = response.read(64 * 1024 * 1024 + 1)
            break
        except urllib.error.HTTPError as error:
            error.close()
            if error.code not in {408, 429, 500, 502, 503, 504}:
                raise
            if attempt == attempts - 1:
                body = github_asset_api(url)
                if body is None:
                    raise
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead) as error:
            if isinstance(error, urllib.error.URLError) and isinstance(error.reason, ssl.SSLCertVerificationError):
                raise
            if attempt == attempts - 1:
                body = github_asset_api(url)
                if body is None:
                    raise
                break
        time.sleep(2 ** attempt)
    if len(body) > 64 * 1024 * 1024:
        raise ValueError("Package manager distribution exceeds the size limit")
    return body


def verified(download):
    body = downloaded(download["url"])
    if "integrity" in download:
        actual = "sha512-" + base64.b64encode(hashlib.sha512(body).digest()).decode()
        expected = download["integrity"]
    else:
        actual, expected = hashlib.sha256(body).hexdigest(), download["sha256"]
    if actual != expected:
        raise ValueError("Package manager distribution hash mismatch; nothing was executed")
    return body


def install(data, name, prefix):
    validate(data)
    prefix.mkdir(parents=True, exist_ok=True)
    binaries = prefix / "bin"
    binaries.mkdir(exist_ok=True)
    downloads = data["tool_downloads"]
    if name == "pip":
        wheel = prefix / f"pip-{data['pip']}-py3-none-any.whl"
        wheel.write_bytes(verified(downloads["pip"]))
        # Run the verified new pip directly from the wheel, not an outdated pip.
        subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", "--no-index", str(wheel)],
                       env={**os.environ, "PYTHONPATH": str(wheel)}, check=True)
        result = subprocess.run([sys.executable, "-m", "pip", "--version"], check=True, capture_output=True, text=True).stdout.strip()
        if not result.startswith("pip " + data["pip"] + " "):
            raise ValueError("Installed pip differs from the reviewed pin")
        print(result)
        return
    if name == "uv":
        system, machine = platform.system().lower(), platform.machine().lower()
        machine = {"arm64": "aarch64", "amd64": "x86_64"}.get(machine, machine)
        target = f"{system}-{machine}"
        if target not in TARGETS:
            raise ValueError("Unsupported uv platform")
        body = verified(downloads["uv"][target])
    else:
        body = verified(downloads["npm"])
    directory = prefix / name
    directory.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as archive:
        archive.extractall(directory, filter="data")
    if name == "uv":
        for executable in ("uv", "uvx"):
            source = directory / ("uv-" + TARGETS[target]) / executable
            shutil.copy2(source, binaries / executable)
    else:
        for executable in ("npm", "npx"):
            # Node executes only the archive whose integrity was verified above.
            script = binaries / executable
            entry = directory / "package/bin" / (executable + "-cli.js")
            script.write_text('#!/bin/sh\nexec node ' + shlex.quote(str(entry)) + ' "$@"\n')
            script.chmod(0o755)
    result = subprocess.run([str(binaries / name), "--version"], check=True, capture_output=True, text=True).stdout.strip()
    expected = data[name]
    if result != expected and not (name == "uv" and result.startswith("uv " + expected + " ")):
        raise ValueError("Installed package manager differs from the reviewed pin")
    if os.environ.get("GITHUB_PATH"):
        with open(os.environ["GITHUB_PATH"], "a") as output:
            output.write(str(binaries) + "\n")
    print(name + ": " + result)


def docker_block(data, name):
    if name == "npm":
        pin = data["tool_downloads"][name]
        return f'''# BEGIN managed npm
ARG NPM_VERSION={data['npm']}
ARG NPM_URL={pin['url']}
ARG NPM_INTEGRITY={pin['integrity']}
RUN node --input-type=module -e 'import {{createHash}} from "node:crypto"; import {{writeFileSync}} from "node:fs"; const r=await fetch(process.env.NPM_URL); if(!r.ok) throw new Error("npm download failed"); const b=Buffer.from(await r.arrayBuffer()); if("sha512-"+createHash("sha512").update(b).digest("base64")!==process.env.NPM_INTEGRITY) throw new Error("npm integrity mismatch"); writeFileSync("/tmp/npm.tgz",b)' \\
    && mkdir -p /opt/verified-npm \\
    && tar -xzf /tmp/npm.tgz -C /opt/verified-npm --strip-components=1 \\
    && ln -sf /opt/verified-npm/bin/npm-cli.js /usr/local/bin/npm \\
    && ln -sf /opt/verified-npm/bin/npx-cli.js /usr/local/bin/npx \\
    && rm /tmp/npm.tgz \\
    && test "$(npm --version)" = "$NPM_VERSION"
# END managed npm'''
    pin = data["tool_downloads"]["pip"]
    return f'''# BEGIN managed pip
ARG PIP_VERSION={data['pip']}
ARG PIP_URL={pin['url']}
ARG PIP_SHA256={pin['sha256']}
RUN python -c 'import hashlib,os,pathlib,sys,urllib.request; b=urllib.request.urlopen(os.environ["PIP_URL"],timeout=60).read(); sys.exit("pip integrity mismatch") if hashlib.sha256(b).hexdigest()!=os.environ["PIP_SHA256"] else None; pathlib.Path("/tmp/pip-"+os.environ["PIP_VERSION"]+"-py3-none-any.whl").write_bytes(b)' \\
    && PYTHONPATH="/tmp/pip-${{PIP_VERSION}}-py3-none-any.whl" python -m pip install --no-deps --no-index "/tmp/pip-${{PIP_VERSION}}-py3-none-any.whl" \\
    && rm "/tmp/pip-${{PIP_VERSION}}-py3-none-any.whl" \\
    && python -c 'import os,pip,sys; sys.exit(0 if pip.__version__==os.environ["PIP_VERSION"] else 1)'
# END managed pip'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manager", choices=["npm", "pip", "uv", "github-asset"])
    parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().parents[2] / ".github/runtime-versions.json")
    parser.add_argument("--prefix", type=Path)
    parser.add_argument("--url")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.manager == "github-asset":
        if not args.url or not args.output or not GITHUB_RELEASE_URL.fullmatch(args.url):
            parser.error("github-asset requires an official release URL and an output file")
        # Stage bytes only. Callers must verify their pinned hash before extraction/use.
        args.output.write_bytes(downloaded(args.url))
        return
    prefix = args.prefix or Path(tempfile.mkdtemp(prefix="verified-tools-", dir=os.environ.get("RUNNER_TEMP")))
    install(json.loads(args.manifest.read_text()), args.manager, prefix)


if __name__ == "__main__":
    main()
