"""Build immutable public-code bundles; never package application .env or DB values."""
import argparse
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = [
    "neon-admin.cjs", "neon-policy.cjs", "neon-profiles.json", "with-neon-credentials.py",
    "production-smoke.mjs", "production-smoke-policy.cjs", "production-stream-proof.cjs",
    "backup-restore.mjs", "provision-public-demo.mjs", "public-demo-policy.cjs",
]


def archive(destination, files):
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as output:
        for source, name in sorted(files, key=lambda pair: pair[1]):
            if not source.is_file() or source.is_symlink():
                raise ValueError("Bundle files must be regular files: " + str(source))
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            output.writestr(info, source.read_bytes())
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def operator_files():
    operator = [(ROOT / ".github/scripts" / name, ".github/scripts/" + name) for name in SCRIPTS]
    for name in ["package.json", "package-lock.json", "Dockerfile", "fixtures/smoke.mp4", "fixtures/README.md"]:
        operator.append((ROOT / ".github/operations-tools" / name, ".github/operations-tools/" + name))
    for name in ["runtime/job.cjs", "runtime/policy.cjs", "fetch_migration.py"]:
        operator.append((ROOT / "infra/db-maintenance" / name, "infra/db-maintenance/" + name))
    operator.append((ROOT / "infra/sql/neon-security.sql", "infra/sql/neon-security.sql"))
    for name in ["content/course.json", *["public/lessons/" + key + ".mp4" for key in ["japanese", "math", "science", "social", "english"]]]:
        operator.append((ROOT / "apps/demo-video" / name, "apps/demo-video/" + name))
    return operator


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "infra/db-maintenance/dist")
    parser.add_argument("--allow-dirty", action="store_true", help="Local validation only; do not deploy dirty bundles")
    args = parser.parse_args()
    dirty = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True)
    if dirty and not args.allow_dirty:
        raise SystemExit("Commit and review all source changes before building a deployment bundle")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    directory = args.output.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    runtime = ROOT / "infra/db-maintenance/runtime"
    if not (runtime / "node_modules/@aws-sdk/client-sfn/package.json").is_file():
        raise SystemExit("Install locked runtime dependencies with npm ci --ignore-scripts first")
    broker = [(runtime / name, name) for name in ["broker.cjs", "policy.cjs", "package.json", "package-lock.json"]]
    broker += [(p, p.relative_to(runtime).as_posix()) for p in (runtime / "node_modules").rglob("*") if p.is_file()]
    operator_hash = archive(directory / "operator.zip", operator_files())
    broker_hash = archive(directory / "broker.zip", broker)
    manifest = {"source_commit": source, "dirty": bool(dirty), "operator_sha256": operator_hash, "broker_sha256": broker_hash}
    definition = subprocess.check_output(["node", str(ROOT / "infra/db-maintenance/state-machine.cjs"), "--production"], text=True)
    (directory / "state-machine.json").write_text(definition)
    manifest["state_machine_sha256"] = hashlib.sha256(definition.encode()).hexdigest()
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    variables = {"source_commit": source, "operator_zip": str(directory / "operator.zip"), "broker_zip": str(directory / "broker.zip")}
    (directory / "terraform.tfvars.json").write_text(json.dumps(variables, indent=2) + "\n")
    print(json.dumps({"bundles": str(directory), **manifest}))


if __name__ == "__main__":
    main()
