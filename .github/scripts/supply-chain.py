"""Inspect lockfiles as data; never import or install the packages being checked."""
import argparse
import base64
import json
import pathlib
import re
import subprocess
import tomllib
import urllib.parse
import urllib.request


def registry_url(value, host):
    url = urllib.parse.urlsplit(value)
    return (url.scheme == "https" and url.netloc == host and
            not url.username and not url.password and not url.fragment and not url.query)


def npm_packages(lock, allowed_scripts):
    if lock.get("lockfileVersion") != 3 or not isinstance(lock.get("packages"), dict):
        raise ValueError("Expected an npm v3 lockfile")
    result = {}
    for location, package in lock["packages"].items():
        if "node_modules/" not in location:
            continue  # Workspace manifests, not downloaded packages.
        # npm aliases retain their registry identity in the lockfile's name.
        # Audit the actual package, not the alias used to install it.
        name = package.get("name", location.rsplit("node_modules/", 1)[1])
        if package.get("link"):
            target = package.get("resolved", "")
            if (not target or target.startswith("/") or ".." in target.split("/") or
                    "node_modules" in target.split("/") or target not in lock["packages"]):
                raise ValueError(f"Unsafe workspace link: {location}")
            continue
        # Bundled children are covered by the enclosing tarball's integrity.
        if package.get("inBundle"):
            parent = location.rsplit("/node_modules/", 1)[0]
            if parent == location or parent not in lock["packages"]:
                raise ValueError(f"Missing enclosing tarball: {location}")
            continue
        version = package.get("version", "")
        if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][\w.+-]+)?", version):
            raise ValueError(f"Non-registry version: {location}")
        if not registry_url(package.get("resolved", ""), "registry.npmjs.org"):
            raise ValueError(f"Unapproved npm source: {location}")
        integrity = package.get("integrity", "")
        # Some older npm releases have only SHA-1 registry integrity. They may
        # remain unchanged, but cannot be introduced by an automatic update.
        if not re.fullmatch(r"sha(?:512|1)-[A-Za-z0-9+/]+={0,2}", integrity):
            raise ValueError(f"Missing registry integrity: {location}")
        algorithm, digest = integrity.split("-", 1)
        if len(base64.b64decode(digest, validate=True)) != (64 if algorithm == "sha512" else 20):
            raise ValueError(f"Invalid integrity: {location}")
        if package.get("hasInstallScript") and name not in allowed_scripts:
            raise ValueError(f"New lifecycle-script package requires policy review: {name}")
        key = ("npm", name, version)
        if key in result and result[key] != integrity:
            raise ValueError(f"Conflicting integrity: {name}@{version}")
        result[key] = integrity
    return result


def python_packages(lock):
    if lock.get("version") != 1 or not isinstance(lock.get("package"), list):
        raise ValueError("Expected a uv v1 lockfile")
    result = {}
    for package in lock["package"]:
        source = package.get("source", {})
        if source in ({"editable": "."}, {"virtual": "."}):
            continue
        cpu_torch = package["name"] == "torch" and source == {"registry": "https://download.pytorch.org/whl/cpu"}
        if not cpu_torch and source != {"registry": "https://pypi.org/simple"}:
            raise ValueError(f"Unapproved Python source: {package['name']}")
        artifacts = package.get("wheels", []) + ([package["sdist"]] if "sdist" in package else [])
        if not artifacts or not package.get("wheels"):
            raise ValueError(f"Registry wheels required: {package['name']}")
        for artifact in artifacts:
            host = urllib.parse.urlsplit(artifact.get("url", "")).netloc if cpu_torch else "files.pythonhosted.org"
            if ((cpu_torch and host not in {"download.pytorch.org", "download-r2.pytorch.org"}) or
                    not registry_url(artifact.get("url", ""), host) or
                    (cpu_torch and not urllib.parse.urlsplit(artifact["url"]).path.startswith("/whl/cpu/torch-")) or
                    not re.fullmatch(r"sha256:[a-f0-9]{64}", artifact.get("hash", ""))):
                raise ValueError(f"Unverified Python artifact: {package['name']}")
        # CPU wheel local tags identify builds of the same public Torch release.
        public_version = package["version"].split("+", 1)[0] if cpu_torch else package["version"]
        key = ("PyPI", package["name"], public_version)
        result.setdefault(key, {}).update({artifact["url"]: artifact["hash"] for artifact in artifacts})
    return result


def check_changes(before, after):
    for key in before.keys() & after.keys():
        old, new = before[key], after[key]
        if isinstance(old, dict):
            # Publishing an additional wheel is legitimate; replacing an
            # existing artifact without a version bump is not.
            changed = any(old[url] != new[url] for url in old.keys() & new.keys())
        else:
            changed = old != new
        if changed:
            raise ValueError(f"An existing release changed integrity: {key}")
    added = sorted(after.keys() - before.keys())
    for key in added:
        if key[0] == "npm" and not after[key].startswith("sha512-"):
            raise ValueError(f"New npm versions require SHA-512: {key}")
    return added


def scan_osv(packages):
    """Fail closed for known vulnerabilities and unavailable/incomplete results."""
    for start in range(0, len(packages), 100):
        batch = packages[start:start + 100]
        payload = {"queries": [{"package": {"ecosystem": eco, "name": name}, "version": version}
                               for eco, name, version in batch]}
        request = urllib.request.Request("https://api.osv.dev/v1/querybatch",
                                         json.dumps(payload).encode(),
                                         {"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            results = json.load(response).get("results")
        if not isinstance(results, list) or len(results) != len(batch):
            raise ValueError("Incomplete OSV response")
        vulnerable = []
        for package, result in zip(batch, results):
            if not isinstance(result, dict) or result.get("next_page_token"):
                raise ValueError("Incomplete OSV result")
            if result.get("vulns"):
                vulnerable.append((package, [item["id"] for item in result["vulns"]]))
        if vulnerable:
            raise ValueError(f"Known vulnerabilities in introduced versions: {vulnerable}")


def read_base(ref, filename):
    if not re.fullmatch(r"[a-f0-9]{40}", ref):
        raise ValueError("Base must be a full commit SHA")
    exists = subprocess.run(["git", "cat-file", "-e", f"{ref}:{filename}"], capture_output=True)
    if exists.returncode:
        # Do not silently convert an unfetched/invalid base to an empty graph.
        subprocess.run(["git", "cat-file", "-e", f"{ref}^{{commit}}"], check=True)
        return None
    return subprocess.check_output(["git", "show", f"{ref}:{filename}"], text=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--offline", action="store_true", help="Structural tests only; never used in CI")
    args = parser.parse_args()
    policy = json.loads(pathlib.Path(".github/supply-chain-policy.json").read_text())
    introduced = []
    for filename in policy["npm_lockfiles"]:
        current = npm_packages(json.loads(pathlib.Path(filename).read_text()), policy["reviewed_install_script_packages"])
        previous_text = read_base(args.base, filename)
        # Baseline parsing tolerates old incomplete lock entries only when
        # adding their previously absent integrity, never for future installs.
        previous = {}
        if previous_text:
            old = json.loads(previous_text)
            for location, package in list(old["packages"].items()):
                if "node_modules/" in location and not package.get("resolved") and not package.get("link"):
                    del old["packages"][location]
            previous = npm_packages(old, policy["reviewed_install_script_packages"])
        introduced.extend(check_changes(previous, current))
    for filename in policy.get("uv_lockfiles", []):
        current = python_packages(tomllib.loads(pathlib.Path(filename).read_text()))
        previous_text = read_base(args.base, filename)
        previous = python_packages(tomllib.loads(previous_text)) if previous_text else {}
        introduced.extend(check_changes(previous, current))
    introduced = sorted(set(introduced))
    print(f"Validated lockfile sources and integrity; {len(introduced)} introduced versions")
    if not args.offline:
        scan_osv(introduced)


if __name__ == "__main__":
    main()
