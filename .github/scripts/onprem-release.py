"""Assemble signed release metadata, or verify it before producing Helm values.

Uses the operator's authenticated gh CLI. Verification fails closed; no cluster
changes are made. Trust this script from a reviewed checkout, never a bundle.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

REPOSITORY = "videoq-jp/videoq"
HISTORICAL_REPOSITORY = "yukiharada1228/videoq"
WORKFLOW = REPOSITORY + "/.github/workflows/onprem-release.yml"
APP_COMPONENTS = ("api", "worker", "web")
COMPONENTS = (*APP_COMPONENTS, "transcription-gateway")
SCHEMA3_COMPONENTS = (*COMPONENTS, "vllm-engine")
LEGACY_COMPONENTS = (*APP_COMPONENTS, "whisper", "whisper-vllm")
PLATFORMS = {c: ["linux/amd64", "linux/arm64"] for c in COMPONENTS}
CHARTS = {"application": "videoq", "inference": "videoq-inference"}
PREFIX = "ghcr.io/" + REPOSITORY + "-"
LEGACY_PREFIX = PREFIX + "onprem-"


def layout(version):
    if type(version) is not int or version not in (2, 3, 4, 5):
        raise ValueError("Unsupported release schema version")
    components = {2: LEGACY_COMPONENTS, 3: SCHEMA3_COMPONENTS, 4: SCHEMA3_COMPONENTS, 5: COMPONENTS}[version]
    prefix = LEGACY_PREFIX if version == 2 else PREFIX
    platforms = {c: (["linux/amd64"] if c in ("whisper-vllm", "vllm-engine") else ["linux/amd64", "linux/arm64"]) for c in components}
    return components, prefix, platforms


def repository(component, version=5, source_repository=REPOSITORY):
    if source_repository not in (REPOSITORY, HISTORICAL_REPOSITORY):
        raise ValueError("Unexpected release repository")
    components, prefix, _ = layout(version)
    prefix = "ghcr.io/" + source_repository + ("-onprem-" if version == 2 else "-")
    if component not in components:
        raise ValueError("Unknown release component")
    if component == "vllm-engine":
        return "ghcr.io/" + source_repository + ("-onprem-whisper-vllm" if version == 3 else "-vllm")
    return prefix + component


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{40}", value):
        raise ValueError("An exact reviewed source commit SHA is required")
    return value


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", value):
        raise ValueError("An immutable SHA-256 digest is required")
    if value == "sha256:" + "0" * 64:
        raise ValueError("Placeholder digests are not deployable")
    return value


def validate(data, expected_sha):
    sha(expected_sha)
    components, prefix, platforms = layout(data.get("schemaVersion"))
    if data.get("repository") not in (REPOSITORY, HISTORICAL_REPOSITORY) or data.get("sourceSha") != expected_sha:
        raise ValueError("Release repository or source commit does not match the reviewed source")
    if set(data.get("images", {})) != set(components):
        raise ValueError("Release must include all application and inference components")
    for component in components:
        image = data["images"][component]
        if image.get("repository") != repository(component, data["schemaVersion"], data["repository"]):
            raise ValueError("Unexpected image repository")
        if image.get("platforms") != platforms[component]:
            raise ValueError("Unexpected image architectures")
        digest(image.get("digest"))
    if set(data.get("charts", {})) != set(CHARTS):
        raise ValueError("Release must include both application and inference charts")
    for key, name in CHARTS.items():
        chart = data["charts"][key]
        if chart.get("name") != name + "-0.1.0-sha." + expected_sha + ".tgz":
            raise ValueError("Unexpected chart filename")
        digest(chart.get("digest"))
    return data


def attest(target, source, predicate=None, *, source_repository=REPOSITORY):
    if source_repository not in (REPOSITORY, HISTORICAL_REPOSITORY):
        raise ValueError("Unexpected release repository")
    command = ["gh", "attestation", "verify", str(target), "--repo", source_repository,
               "--signer-workflow", source_repository + "/.github/workflows/onprem-release.yml", "--source-ref", "refs/heads/main",
               "--source-digest", sha(source), "--deny-self-hosted-runners"]
    if predicate:
        command += ["--predicate-type", predicate]
    # Do not shell-expand release metadata. gh verifies the signature, subject,
    # GitHub OIDC identity and source revision, not just an embedded predicate.
    if source_repository == HISTORICAL_REPOSITORY:
        # Attestations remain under their original owner after a repository
        # transfer. Fetch the bundle there, then apply the SAME exact repository,
        # workflow, source-ref and commit policy locally; never trust lookup scope
        # as a substitute for signature verification.
        with tempfile.TemporaryDirectory(prefix="videoq-historical-attestation-") as directory:
            artifact = str(target) if str(target).startswith("oci://") else str(Path(target).resolve())
            subprocess.run(["gh", "attestation", "download", artifact, "--owner", "yukiharada1228"],
                           cwd=directory, check=True)
            bundles = list(Path(directory).glob("*.jsonl"))
            if len(bundles) != 1:
                raise ValueError("Expected exactly one historical attestation bundle")
            subprocess.run(command + ["--bundle", str(bundles[0])], check=True)
    else:
        subprocess.run(command, check=True)


def verify(manifest, source):
    data = validate(json.loads(manifest.read_text()), source)
    # Metadata selects only between two fixed identities; verify every signature
    # against that exact identity, never an arbitrary repository from a bundle.
    identity = data["repository"]
    attest(manifest, source, source_repository=identity)
    for entry in data["charts"].values():
        chart = manifest.parent / entry["name"]
        if "sha256:" + hashlib.sha256(chart.read_bytes()).hexdigest() != entry["digest"]:
            raise ValueError("Chart bytes do not match the signed release")
        attest(chart, source, source_repository=identity)
    for component in data["images"]:
        image = data["images"][component]
        attest("oci://" + image["repository"] + "@" + image["digest"], source, source_repository=identity)
    def image(component):
        return {k: data["images"][component][k] for k in ("repository", "digest")}
    application = {"requireImageDigests": True, **{
        c: {"image": {**image(c), "tag": "", "pullPolicy": "IfNotPresent"}}
        for c in APP_COMPONENTS}}
    inference = {"requireImageDigests": True}
    if data["schemaVersion"] == 5:
        inference["whisper"] = {"image": image("transcription-gateway")}
    else:
        gateway, engine = ("whisper", "whisper-vllm") if data["schemaVersion"] == 2 else ("transcription-gateway", "vllm-engine")
        inference.update({"whisper": {"image": image(gateway), "vllmImage": image(engine)},
                          "vllm": {"image": image(engine)}})
    return application, inference


def write_atomic(path, data):
    path = path.resolve()
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        try:
            json.dump(data, output, indent=2)
            output.write("\n")
            output.close()
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("assemble")
    create.add_argument("source")
    create.add_argument("directory", type=Path)
    check = sub.add_parser("verify")
    check.add_argument("source")
    check.add_argument("manifest", type=Path)
    check.add_argument("output", type=Path)
    check.add_argument("inference_output", type=Path)
    args = parser.parse_args()
    sha(args.source)
    if args.command == "verify":
        outputs = [args.output.resolve(), args.inference_output.resolve()]
        if len(set(outputs)) != 2 or any(p == args.manifest.resolve() or p.suffix == ".tgz" for p in outputs):
            raise ValueError("Outputs must be distinct and must not overwrite signed artifacts")
        application, inference = verify(args.manifest, args.source)
        write_atomic(args.output, application)
        write_atomic(args.inference_output, inference)
        print("Verified release; application and inference Helm image values written")
        return
    charts = {key: args.directory / (name + "-0.1.0-sha." + args.source + ".tgz") for key, name in CHARTS.items()}
    data = {"schemaVersion": 5, "repository": REPOSITORY, "sourceSha": args.source,
            "images": {c: {"repository": repository(c),
                           "platforms": PLATFORMS[c],
                           "digest": (args.directory / (c + ".digest")).read_text().strip()} for c in COMPONENTS},
            "charts": {key: {"name": chart.name, "digest": "sha256:" + hashlib.sha256(chart.read_bytes()).hexdigest()} for key, chart in charts.items()}}
    write_atomic(args.directory / "release.json", validate(data, args.source))


if __name__ == "__main__":
    main()
