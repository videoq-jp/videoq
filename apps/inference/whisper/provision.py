"""Provision pinned local LLM and speech weights; never run in a serving container.

Uses the Whisper image's locked huggingface-hub dependency for both GGUF files
and safetensors snapshots, including GGML speech weights. Runtime servers receive a read-only revision folder.
"""
import hashlib
import json
import os
from pathlib import Path
import re

from huggingface_hub import hf_hub_download, snapshot_download


def provision(env=os.environ):
    repo, revision = env["MODEL_REPO"], env["MODEL_REVISION"]
    filename, digest = env.get("MODEL_FILE", ""), env.get("MODEL_SHA256", "")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Model repository and immutable 40-character revision are required")
    if filename and (Path(filename).name != filename or not (filename.endswith(".gguf") or re.fullmatch(r"ggml-[a-z0-9_.-]+\.bin", filename)) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
        raise ValueError("GGUF/GGML requires a basename and reviewed SHA256")
    directory = Path(env.get("MODEL_ROOT", "/models")) / revision
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / ".videoq-model.json"
    identity = {"repo": repo, "revision": revision, "file": filename, "sha256": digest}
    if marker.exists():
        cached = json.loads(marker.read_text())
        if cached["identity"] != identity:
            raise ValueError("Cached model identity differs; use a new claim")
        if all((directory / name).is_file() and (directory / name).stat().st_size == size for name, size in cached["files"].items()):
            if not filename:
                return directory
            with (directory / filename).open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() == digest:
                    return directory
    if filename:
        path = hf_hub_download(repo, filename, revision=revision, local_dir=directory)
        with open(path, "rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                raise ValueError("Model checksum mismatch")
        files = {filename: Path(path).stat().st_size}
    else:
        # No pickle weights or downloaded Python code; trust_remote_code stays off.
        snapshot_download(repo, revision=revision, local_dir=directory,
                          allow_patterns=["*.safetensors", "*.json", "*.jinja", "*.txt", "*.model", "tokenizer.*"],
                          # gpt-oss also ships a second native-format checkpoint.
                          # vLLM uses the root Transformers shards, not original/.
                          ignore_patterns=["original/**"])
        files = {str(p.relative_to(directory)): p.stat().st_size for p in directory.rglob("*")
                 if p.is_file() and ".cache" not in p.relative_to(directory).parts and p != marker}
        if not any(name.endswith(".safetensors") for name in files) or "config.json" not in files:
            raise ValueError("Incomplete safetensors model snapshot")
    temporary = marker.with_suffix(".tmp")
    temporary.write_text(json.dumps({"identity": identity, "files": files}))
    temporary.replace(marker)
    return directory


if __name__ == "__main__":
    print(provision())
