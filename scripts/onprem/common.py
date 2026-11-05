"""Validated URLs, image references and pinned single-node infrastructure images."""
import re
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit

INFRA = {
    "gateway": "caddy:2-alpine@sha256:e70b164da81ef698b3ad19af799ea6086ce6d9e48ed4079eb9fe26f6fbf14ee5",
    "postgres": "pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d",
    "garage": "dxflrs/garage:v2.5.0@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5",
    "queue": "softwaremill/elasticmq:latest@sha256:f1de391a9b8c18fd3f2ce37b4f7d1b8989857e8a8e18bb01284fff899e69da82",
}


def origin(value):
    parsed = urlsplit(value)
    parsed.port  # Validate numeric port and range before generating Caddy configuration.
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment or any(c.isspace() for c in value)
            or any(c in value for c in '{}$\\"')):
        raise ValueError("公開URLはパス・認証情報を含まないHTTP(S)のURLを指定してください")
    hostname = parsed.hostname.encode("idna").decode("ascii")
    host = f"[{hostname}]" if ":" in hostname else hostname
    port = parsed.port
    if port is not None and port != (443 if parsed.scheme == "https" else 80):
        host += f":{port}"
    # Browser origins lowercase hosts and omit default ports. CORS must match.
    return f"{parsed.scheme}://{host}"


def image_refs(values):
    refs = {}
    if not isinstance(values, dict):
        raise ValueError("--images には署名検証で生成したverified-images.jsonを指定してください")
    for component in ("api", "worker", "web"):
        item = values.get(component)
        image = item.get("image") if isinstance(item, dict) else None
        repository = image.get("repository") if isinstance(image, dict) else None
        digest = image.get("digest") if isinstance(image, dict) else None
        if (not isinstance(repository, str) or not isinstance(digest, str)
                or not re.fullmatch(r"[a-z0-9][a-z0-9./:_-]*", repository)
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)):
            raise ValueError(f"{component}: 検証済みのrepositoryとdigestが必要です")
        refs[component] = repository + "@" + digest
    return refs


def private_json(path, value):
    # Write privately and atomically, including credentials and resume state.
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.close()
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)



def json_documents(raw):
    decoder, result = json.JSONDecoder(), []
    while raw.strip():
        raw = raw.lstrip()
        obj, end = decoder.raw_decode(raw)
        result.extend(obj['items'] if obj.get('kind') == 'List' else [obj])
        raw = raw[end:]
    return result
