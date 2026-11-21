#!/usr/bin/env python3
"""Single-server VideoQ installer. Requires Python 3.9+ and Docker Compose."""

import argparse
from contextlib import contextmanager
import fcntl
import getpass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import ssl
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
PUBLIC_FILES = {"storage-init.py", "diagnostics.py", "scheduler.mjs", "elasticmq.conf", "garage.toml", "Caddyfile"}
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


def compose(refs, public_url, storage_url, bind_address=None):
    prefix = ""
    if bind_address:
        address = ipaddress.ip_address(bind_address)
        prefix = (f"[{address}]" if address.version == 6 else str(address)) + ":"
    tcp_ports, udp_ports = set(), set()
    for value in (public_url, storage_url):
        url = urlsplit(value)
        port = url.port or (443 if url.scheme == "https" else 80)
        tcp_ports.add(port)
        if url.scheme == "https":
            tcp_ports.add(80)  # ACME HTTP challenge and HTTPS redirects.
            udp_ports.add(port)
    ports = [f"{prefix}{port}:{port}" for port in sorted(tcp_ports)]
    ports += [f"{prefix}{port}:{port}/udp" for port in sorted(udp_ports)]
    runtime = {"env_file": ["runtime.env"], "restart": "unless-stopped"}
    services = {
        "postgres": {"image": INFRA["postgres"], "env_file": ["postgres.env"],
                     "volumes": ["postgres_data:/var/lib/postgresql/data"], "restart": "unless-stopped",
                     "healthcheck": {"test": ["CMD-SHELL", "pg_isready -U videoq -d videoq"], "interval": "5s", "timeout": "5s", "retries": 30}},
        "garage": {"image": INFRA["garage"], "command": ["/garage", "server", "--single-node", "--default-bucket"],
                   "env_file": ["garage.env"], "volumes": ["./garage.toml:/etc/garage.toml:ro", "garage_data:/var/lib/garage"],
                   "restart": "unless-stopped"},
        "queue": {"image": INFRA["queue"], "volumes": ["./elasticmq.conf:/opt/elasticmq.conf:ro", "queue_data:/data"],
                  "restart": "unless-stopped",
                  "depends_on": {"queue-init": {"condition": "service_completed_successfully"}},
                  "healthcheck": {"test": ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:9324/?Action=ListQueues&Version=2012-11-05"],
                                  "interval": "5s", "timeout": "5s", "retries": 30}},
        "queue-init": {"image": INFRA["postgres"], "user": "0:0", "entrypoint": ["chown"],
                       "command": ["999:999", "/data"], "network_mode": "none", "volumes": ["queue_data:/data"]},
        "storage-init": {"image": refs["worker"], "env_file": ["garage.env"],
                         "depends_on": {"garage": {"condition": "service_started"}},
                         "command": ["python", "/init.py"], "volumes": ["./storage-init.py:/init.py:ro"]},
        "migrate": {"image": refs["api"], "env_file": ["runtime.env"],
                    "command": ["sh", "scripts/db-migrate.sh"],
                    "depends_on": {"postgres": {"condition": "service_healthy"}}},
        "api": {**runtime, "image": refs["api"],
                "healthcheck": {"test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:8787/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                                "interval": "5s", "timeout": "5s", "retries": 30},
                "depends_on": {"migrate": {"condition": "service_completed_successfully"},
                               "queue": {"condition": "service_healthy"},
                               "storage-init": {"condition": "service_completed_successfully"}}},
        "worker": {**runtime, "image": refs["worker"], "init": True, "stop_grace_period": "960s",
                   "environment": {"R2_S3_ENDPOINT": "http://garage:3900"},
                   "depends_on": {"migrate": {"condition": "service_completed_successfully"},
                                  "queue": {"condition": "service_healthy"},
                                  "storage-init": {"condition": "service_completed_successfully"}}},
        "web": {"image": refs["web"], "restart": "unless-stopped",
                "environment": {"VIDEOQ_CSP_STORAGE_ORIGINS": storage_url}},
        "gateway": {"image": INFRA["gateway"], "restart": "unless-stopped",
                    "ports": ports,
                    "volumes": ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data", "caddy_config:/config"],
                    "depends_on": ["api", "web", "garage"]},
        "scheduler": {**runtime, "image": refs["api"], "command": ["node", "/scheduler.mjs"],
                      "volumes": ["./scheduler.mjs:/scheduler.mjs:ro"],
                      "depends_on": {"migrate": {"condition": "service_completed_successfully"}}},
    }
    for command in ("maintenance", "retention"):
        services[command] = {"image": refs["api"], "env_file": ["runtime.env"],
                             "profiles": ["tools"], "command": ["node", "dist/node.mjs", command]}
    services["diagnostics"] = {"image": refs["worker"], "env_file": ["runtime.env"], "profiles": ["tools"],
                               "entrypoint": ["python", "/diagnostics.py"], "volumes": ["./diagnostics.py:/diagnostics.py:ro"]}
    volumes = ("postgres_data", "garage_data", "queue_data", "caddy_data", "caddy_config")
    services["snapshot"] = {"image": INFRA["postgres"], "profiles": ["tools"],
                            "user": "0:0", "entrypoint": ["tar"], "network_mode": "none",
                            "volumes": [f"{name}:/snapshot/{name}" for name in volumes]}
    return {"name": "videoq-" + secrets.token_hex(6), "services": services,
            "volumes": {name: {} for name in volumes}}


def write_private(path, content):
    # Restrict access at creation, before writing any credential bytes. O_EXCL
    # refuses existing paths, including symlinks; do not widen a caller's umask.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(content)


def env_text(values):
    # Compose env_file supports literal single-quoted values; reject control characters.
    if any("'" in str(v) or any(c in str(v) for c in "\r\n\x00") for v in values.values()):
        raise ValueError("設定値には改行・シングルクォートを使用できません")
    return "".join(f"{k}='{v}'\n" for k, v in values.items())


def initialize(args):
    public_url = origin(args.url or input("VideoQ公開URL: "))
    storage_url = origin(args.storage_url or input("ストレージ公開URL: "))
    if public_url == storage_url:
        raise ValueError("ストレージにはVideoQとは別のオリジンが必要です")
    refs = image_refs(json.loads(Path(args.images).read_text()))
    ai = getattr(args, "ai", "hosted")
    key = (os.environ.get("VIDEOQ_OPENROUTER_API_KEY") or getpass.getpass("OpenRouter API key: ")) if ai == "hosted" else "local-inference"
    if not key.strip():
        raise ValueError("OpenRouter API keyが必要です")
    password = secrets.token_hex(32)
    access_key, storage_secret = "GK" + secrets.token_hex(16), secrets.token_hex(32)
    runtime = {
        "DEPLOYMENT_EDITION": "onprem", "NODE_ENV": "production", "ENVIRONMENT": "production",
        "PORT": "8787", "BETTER_AUTH_URL": public_url, "FRONTEND_URL": public_url,
        "CORS_ALLOW_ORIGIN": public_url, "OAUTH_ISSUER_URL": public_url,
        "BETTER_AUTH_SECRET": secrets.token_urlsafe(48), "USER_SECRET_ENCRYPTION_KEY": secrets.token_urlsafe(32),
        "DATABASE_URL": f"postgresql://videoq:{password}@postgres:5432/videoq",
        "USE_S3_STORAGE": "true", "R2_BUCKET_NAME": "videoq-media", "R2_S3_REGION": "garage",
        "R2_S3_ENDPOINT": storage_url, "R2_S3_INTERNAL_ENDPOINT": "http://garage:3900",
        "R2_ACCESS_KEY_ID": access_key, "R2_SECRET_ACCESS_KEY": storage_secret,
        "SQS_QUEUE_URL": "http://queue:9324/000000000000/videoq-jobs",
        "AWS_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": secrets.token_hex(16), "AWS_SECRET_ACCESS_KEY": secrets.token_hex(32),
        "SQS_VISIBILITY_TIMEOUT": "900", "SQS_MAX_MESSAGES": "1", "ENABLE_HEAVY_PIPELINE": "1",
        "OPENROUTER_API_KEY": key, "OPENAI_BASE_URL": "https://openrouter.ai/api/v1",
        "LLM_MODEL": "openai/gpt-6-luna", "EMBEDDING_MODEL": "openai/text-embedding-3-small",
        "EMBEDDING_PROFILE": "openai", "WHISPER_BACKEND": "openrouter", "WHISPER_CHUNK_SECONDS": "300",
        "VIDEO_VISUAL_ENABLED": "true", "TRUST_PROXY_HOPS": "1",
    }
    if ai != "hosted":
        for name in ("chat_url", "embedding_url", "transcription_url"):
            if not getattr(args, name, None):
                raise ValueError(f"ローカルAIには --{name.replace('_', '-')} が必要です")
        # Endpoints include /v1; validate URL origin separately while retaining path.
        def endpoint(value):
            parsed = urlsplit(value)
            origin(f"{parsed.scheme}://{parsed.netloc}")
            if parsed.query or parsed.fragment or any(c.isspace() for c in value):
                raise ValueError("AIエンドポイントにクエリー・フラグメント・空白は指定できません")
            return value.rstrip("/")
        runtime.pop("OPENROUTER_API_KEY")
        runtime.update({
            "OPENAI_API_KEY": os.environ.get("VIDEOQ_LOCAL_AI_KEY", "local-inference"),
            "OPENAI_BASE_URL": endpoint(args.chat_url), "EMBEDDING_BASE_URL": endpoint(args.embedding_url),
            "WHISPER_LOCAL_URL": endpoint(args.transcription_url), "WHISPER_BACKEND": "local",
            "LLM_MODEL": getattr(args, "chat_model", None) or "videoq-chat",
            "EMBEDDING_MODEL": getattr(args, "embedding_model", None) or ("gte-qwen2-1.5b-q4km-124fbdad" if ai == "local-cpu" else "qwen3-embedding-4b-5cf2132a"),
            "LLM_REASONING_EFFORT": "none", "LLM_SEPARATE_TOOL_SCHEMA": "true" if ai == "local-cpu" else "false",
            "LLM_REQUEST_TIMEOUT_MS": "600000", "LLM_STREAM_TIMEOUT_MS": "600000",
            "WHISPER_CHUNK_SECONDS": "30" if ai == "local-cpu" else "300", "VIDEO_VISUAL_ENABLED": "false",
        })
    files = {
        "runtime.env": env_text(runtime),
        "postgres.env": env_text({"POSTGRES_USER": "videoq", "POSTGRES_DB": "videoq", "POSTGRES_PASSWORD": password}),
        "garage.env": env_text({"GARAGE_DEFAULT_ACCESS_KEY": access_key, "GARAGE_DEFAULT_SECRET_KEY": storage_secret,
                                "GARAGE_DEFAULT_BUCKET": "videoq-media", "GARAGE_RPC_SECRET": secrets.token_hex(32),
                                "GARAGE_ACCESS_KEY_ID": access_key, "GARAGE_SECRET_ACCESS_KEY": storage_secret,
                                "GARAGE_BUCKET": "videoq-media", "GARAGE_CORS_ORIGINS": public_url}),
        "compose.json": json.dumps(compose(refs, public_url, storage_url, getattr(args, "bind_address", None)), indent=2) + "\n",
        "garage.toml": (ROOT / "infra/garage/garage.toml").read_text().replace("# Single-node local development only. Production storage remains Cloudflare R2.", "# Single-server storage; keep off-host backups."),
        "elasticmq.conf": (ROOT / "infra/elasticmq.conf").read_text() + '\nmessages-storage {\n  enabled = true\n  uri = "jdbc:h2:/data/elasticmq"\n}\n',
        "storage-init.py": (ROOT / "infra/garage/init.py").read_text(),
        "scheduler.mjs": (Path(__file__).parent / "scheduler.mjs").read_text(),
        "diagnostics.py": (Path(__file__).parent / "diagnostics.py").read_text(),
        "Caddyfile": f"""{public_url} {{
    @api path /api /api/* /.well-known/* /health /ready
    handle @api {{
        reverse_proxy api:8787 {{
            flush_interval -1
        }}
    }}
    handle {{
        reverse_proxy web:80
    }}
}}
{storage_url} {{
    reverse_proxy garage:3900
}}
""",
    }
    certificate, certificate_key = getattr(args, "tls_cert", None), getattr(args, "tls_key", None)
    if bool(certificate) != bool(certificate_key):
        raise ValueError("--tls-cert と --tls-key は両方指定してください")
    if certificate:
        if not all(urlsplit(url).scheme == "https" for url in (public_url, storage_url)):
            raise ValueError("独自TLS証明書を使う場合は両方の公開URLをhttpsにしてください")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, certificate_key, password=lambda: "")
        files["site.crt"] = Path(certificate).read_text()
        files["site.key"] = Path(certificate_key).read_text()
        if "-----BEGIN CERTIFICATE-----" not in files["site.crt"] or "PRIVATE KEY-----" not in files["site.key"]:
            raise ValueError("TLS証明書と秘密鍵はPEM形式で指定してください")
        files["Caddyfile"] = files["Caddyfile"].replace(" {\n", " {\n    tls /etc/caddy/site.crt /etc/caddy/site.key\n", 1)
        files["Caddyfile"] = files["Caddyfile"].replace(f"{storage_url} {{\n", f"{storage_url} {{\n    tls /etc/caddy/site.crt /etc/caddy/site.key\n")
        configuration = json.loads(files["compose.json"])
        configuration["services"]["gateway"]["volumes"].extend(["./site.crt:/etc/caddy/site.crt:ro", "./site.key:/etc/caddy/site.key:ro"])
        files["compose.json"] = json.dumps(configuration, indent=2) + "\n"
    target = Path(args.directory).resolve()
    # Refuse reuse, including partial installs: never regenerate encryption keys.
    target.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, content in files.items():
        write_private(target / name, content)
        if name in PUBLIC_FILES:
            # The production worker runs as UID 10001, independently of host UID.
            os.chmod(target / name, 0o644)
    print(f"設定を生成しました: {target}\n次に doctor で環境を確認してください。")


def docker(directory, *arguments, **kwargs):
    # Keep progress messages ahead of child output even when stdout is piped.
    sys.stdout.flush()
    return subprocess.run([*docker_command(), "compose", "--project-directory", str(directory), "-f", str(directory / "compose.json"), *arguments], check=True, **kwargs)


def docker_command():
    # Explicit opt-in for hosts whose Docker socket is available only to root.
    return ["sudo", "-n", "docker"] if os.environ.get("VIDEOQ_DOCKER_SUDO") == "1" else ["docker"]


def doctor(args):
    if not shutil.which("docker"):
        raise ValueError("Dockerが見つかりません。Docker EngineとComposeをインストールしてください")
    subprocess.run([*docker_command(), "compose", "version"], check=True)
    subprocess.run([*docker_command(), "info", "--format", "{{.ServerVersion}}"], check=True)
    directory = Path(args.directory).resolve()
    docker(directory, "config", "--quiet")
    free = shutil.disk_usage(directory).free // (1024 ** 3)
    print(f"設定: OK / 空きディスク: {free} GiB（動画とバックアップの容量を別途確保してください）")
    if getattr(args, "live", False):
        docker(directory, "run", "--rm", "--no-deps", "-T", "diagnostics", *(["--ai"] if args.ai else []))
        # Check the public route too: internal readiness cannot prove DNS/TLS/CORS.
        environment = {}
        for line in (directory / "runtime.env").read_text().splitlines():
            if line.strip() and not line.startswith("#"):
                key, value = line.split("=", 1)
                environment[key] = value.strip().strip("'")
        public_url = environment["BETTER_AUTH_URL"]
        try:
            with urlopen(public_url + "/ready", timeout=15) as response:
                if response.status != 200:
                    raise ValueError("API公開経路がreadyではありません")
            request = Request(environment["R2_S3_ENDPOINT"] + "/" + environment["R2_BUCKET_NAME"] + "/",
                              method="OPTIONS", headers={"Origin": public_url, "Access-Control-Request-Method": "PUT",
                                                         "Access-Control-Request-Headers": "content-type"})
            with urlopen(request, timeout=15) as response:
                if response.headers.get("Access-Control-Allow-Origin") != public_url:
                    raise ValueError("ストレージ公開経路のCORSが一致しません")
        except Exception as error:
            raise ValueError(f"公開URLのDNS・TLS・ルーティング・CORSを確認してください ({type(error).__name__})") from None
        print("公開API・ストレージのDNS/TLS/アップロード用CORS: OK")


def start(args):
    directory = Path(args.directory).resolve()
    doctor(args)
    if not getattr(args, "offline", False):
        docker(directory, "pull")
    docker(directory, "up", "-d", "--wait", "--wait-timeout", "180", "postgres", "garage", "queue")
    docker(directory, "run", "--rm", "storage-init")
    docker(directory, "run", "--rm", "migrate")
    docker(directory, "up", "-d", "--wait", "--wait-timeout", "180")
    print("起動しました。statusで状態を確認し、adminで初期管理者を作成してください。")


def status(args):
    docker(Path(args.directory).resolve(), "ps", "--all")


def stop(args):
    directory = Path(args.directory).resolve()
    docker(directory, "stop", "gateway", "api", "worker", "scheduler", "web")
    docker(directory, "stop")


def logs(args):
    docker(Path(args.directory).resolve(), "logs", "--tail", "100", *([args.service] if args.service else []))


def admin(args):
    docker(Path(args.directory).resolve(), "exec", "api", "node", "dist/provision-user.mjs",
           "--admin", "--username", args.username, "--email", args.email)


def install(args):
    # Gather administrator details before provisioning infrastructure.
    args.username = args.username or input("管理者ユーザー名: ").strip()
    args.email = args.email or input("管理者メールアドレス: ").strip()
    if not args.username or not args.email:
        raise ValueError("管理者のユーザー名とメールアドレスが必要です")
    initialize(args)
    with operation_lock(Path(args.directory).resolve()):
        start(args)
        doctor(argparse.Namespace(directory=args.directory, live=True, ai=False))
        admin(args)


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resume_containers(identifiers, timeout=180):
    """Start existing containers without rerunning one-shot dependencies.

    Compose 2 supports up --wait but not start --wait. Use the Docker engine's
    start and health state so backup recovery works on both Compose 2 and 5.
    """
    subprocess.run([*docker_command(), "start", *identifiers], check=True)
    deadline = time.monotonic() + timeout
    while True:
        result = subprocess.run([*docker_command(), "inspect", "--format", "{{json .State}}", *identifiers],
                                check=True, capture_output=True, text=True)
        states = [json.loads(line) for line in result.stdout.splitlines() if line]
        if len(states) == len(identifiers) and all(
                state.get("Running") and state.get("Health", {}).get("Status", "healthy") == "healthy"
                for state in states):
            return
        if time.monotonic() >= deadline:
            raise ValueError("バックアップ後の再開が準備状態になりません。statusとlogsを確認してください")
        time.sleep(1)


def backup_directory(directory, destination, resume=True):
    """Cold backup: stop all writers before copying all persistent volumes."""
    if destination == directory or directory in destination.parents:
        raise ValueError("バックアップ先は導入ディレクトリの外に指定してください")
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    running = docker(directory, "ps", "--status", "running", "--quiet", capture_output=True, text=True).stdout.split()
    complete = False
    try:
        docker(directory, "stop", "gateway", "api", "worker", "scheduler", "web")
        docker(directory, "stop")
        config = destination / "configuration"
        config.mkdir(mode=0o700)
        for path in directory.iterdir():
            if path.is_file() and not path.is_symlink() and path.name != ".operation.lock":
                write_private(config / path.name, path.read_text())
        archive = destination / "volumes.tgz"
        with archive.open("xb") as stream:
            os.chmod(archive, 0o600)
            docker(directory, "run", "--rm", "--no-deps", "-T", "snapshot", "-czf", "-", "-C", "/snapshot", ".", stdout=stream)
        manifest = {"version": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
                    "files": {str(path.relative_to(destination)): checksum(path)
                              for path in destination.rglob("*") if path.is_file()}}
        write_private(destination / "backup.json", json.dumps(manifest, indent=2) + "\n")
        complete = True
    finally:
        if running and (resume or not complete):
            resume_containers(running)
    return destination


def backup(args):
    destination = backup_directory(Path(args.directory).resolve(), Path(args.output).resolve())
    print(f"バックアップ完了: {destination}\n暗号鍵を含みます。アクセスを制限し、別ホストにも保管してください。")


def verify_backup(source):
    manifest = json.loads((source / "backup.json").read_text())
    if manifest.get("version") != 1 or not manifest.get("files"):
        raise ValueError("対応していないバックアップ形式です")
    for name, digest in manifest["files"].items():
        path = source / name
        if Path(name).is_absolute() or ".." in Path(name).parts or path.is_symlink() or not path.is_file():
            raise ValueError("バックアップのファイルパスが不正です")
        if checksum(path) != digest:
            raise ValueError(f"バックアップのチェックサムが一致しません: {name}")
    required = {"volumes.tgz", "configuration/compose.json", "configuration/runtime.env", "configuration/postgres.env", "configuration/garage.env"}
    if not required.issubset(manifest["files"]):
        raise ValueError("バックアップに必須ファイルがありません")
    config = json.loads((source / "configuration/compose.json").read_text())
    # Only regular files/directories below the five known data volumes are accepted.
    with tarfile.open(source / "volumes.tgz", "r|gz") as archive:
        for member in archive:
            parts = Path(member.name).parts
            if (Path(member.name).is_absolute() or ".." in parts
                    or (parts and parts[0] not in config["volumes"])
                    or not (member.isfile() or member.isdir())):
                raise ValueError("バックアップのアーカイブに不正なパスまたはリンクがあります")
    return config


def restore(args):
    source, target = Path(args.backup).resolve(), Path(args.directory).resolve()
    config = verify_backup(source)
    # Always restore to new volumes; never overwrite the original installation.
    config["name"] = "videoq-" + secrets.token_hex(6)
    target.mkdir(mode=0o700, parents=True, exist_ok=False)
    manifest = json.loads((source / "backup.json").read_text())
    for name in manifest["files"]:
        if name.startswith("configuration/"):
            relative = Path(name).relative_to("configuration")
            if len(relative.parts) != 1:
                raise ValueError("バックアップの設定ファイルパスが不正です")
            content = json.dumps(config, indent=2) + "\n" if relative.name == "compose.json" else (source / name).read_text()
            write_private(target / relative, content)
            if relative.name in PUBLIC_FILES:
                os.chmod(target / relative, 0o644)
    with (source / "volumes.tgz").open("rb") as stream:
        docker(target, "run", "--rm", "--no-deps", "-T", "snapshot", "-xzf", "-", "-C", "/snapshot", stdin=stream)
    print(f"復元しました: {target}\n元の構成を停止してから start で復元先を起動してください。")


def update(args):
    directory = Path(args.directory).resolve()
    refs = image_refs(json.loads(Path(args.images).read_text()))
    current = json.loads((directory / "compose.json").read_text())
    candidate = json.loads(json.dumps(current))
    for component, services in {"api": ("api", "migrate", "scheduler", "maintenance", "retention"),
                                "worker": ("worker", "storage-init", "diagnostics"), "web": ("web",)}.items():
        for service in services:
            candidate["services"][service]["image"] = refs[component]
    # Download before the maintenance window; failures do not interrupt service.
    for ref in refs.values():
        subprocess.run([*docker_command(), "pull", ref], check=True)
    backup_directory(directory, Path(args.backup).resolve(), resume=False)
    pending = directory / f".compose.{secrets.token_hex(6)}.json"
    write_private(pending, json.dumps(candidate, indent=2) + "\n")
    pending.replace(directory / "compose.json")
    try:
        # The reviewed images were pulled before the snapshot; avoid network work
        # while the application is stopped.
        start(argparse.Namespace(**{**vars(args), "offline": True}))
    except (OSError, ValueError, subprocess.CalledProcessError):
        # SQL migrations may already have changed data. Never silently revert images.
        docker(directory, "stop", "gateway", "api", "worker", "scheduler", "web")
        print(f"更新に失敗しました。ログを確認して再試行するか、{args.backup} を新規ディレクトリへrestoreしてください。", file=sys.stderr)
        raise


@contextmanager
def operation_lock(directory):
    """Avoid backup/update/start races against one installation."""
    with (directory / ".operation.lock").open("a") as lock:
        os.chmod(directory / ".operation.lock", 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("この導入先で別の操作が実行中です") from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", default="./videoq-server", help="導入先ディレクトリ")
    commands = parser.add_subparsers(dest="command", required=True)
    setup_options = argparse.ArgumentParser(add_help=False)
    init = setup_options
    init.add_argument("--images", required=True, help="署名検証済みverified-images.json")
    init.add_argument("--url")
    init.add_argument("--storage-url")
    init.add_argument("--bind-address", help="入口ポートを公開するホストIP（省略時は全インターフェース）")
    init.add_argument("--ai", choices=("hosted", "local-cpu", "local-gpu"), default="hosted")
    init.add_argument("--chat-url", help="既存ローカル推論サーバーの /v1 URL")
    init.add_argument("--embedding-url")
    init.add_argument("--transcription-url")
    init.add_argument("--chat-model")
    init.add_argument("--embedding-model")
    init.add_argument("--tls-cert", help="両ホスト名を含むPEM証明書チェーン")
    init.add_argument("--tls-key", help="PEM秘密鍵")
    commands.add_parser("init", parents=[setup_options], help="秘密鍵と単一サーバー構成を生成")
    installation = commands.add_parser("install", parents=[setup_options], help="設定生成・起動・診断・初期管理者作成を一括実行")
    installation.add_argument("--username")
    installation.add_argument("--email")
    installation.add_argument("--offline", action="store_true")
    diagnosis = commands.add_parser("doctor", help="Docker・設定・ディスクの診断")
    diagnosis.add_argument("--live", action="store_true", help="起動済みサービスの認証・CORS・キュー設定も検査")
    diagnosis.add_argument("--ai", action="store_true", help="--live時にAIモデル一覧も確認（推論なし）")
    launch = commands.add_parser("start", help="イメージ取得・初期化・起動")
    launch.add_argument("--offline", action="store_true", help="転送済みイメージを使用しpullを省略")
    commands.add_parser("status", help="コンテナの状態を確認")
    commands.add_parser("stop", help="データを保持して全サービスを停止")
    journal = commands.add_parser("logs", help="直近のログを確認")
    journal.add_argument("--service", choices=("api", "web", "worker", "scheduler", "postgres", "garage", "queue", "gateway", "migrate"))
    administrator = commands.add_parser("admin", help="管理者のセットアップURLを発行")
    administrator.add_argument("--username", required=True)
    administrator.add_argument("--email", required=True)
    snapshot = commands.add_parser("backup", help="全サービスを一時停止してデータと設定を保存")
    snapshot.add_argument("--output", required=True, help="新規のバックアップディレクトリ")
    recovery = commands.add_parser("restore", help="バックアップを新規ディレクトリ・ボリュームへ復元")
    recovery.add_argument("--backup", required=True)
    upgrade = commands.add_parser("update", help="検証済みイメージへバックアップ後に更新")
    upgrade.add_argument("--images", required=True)
    upgrade.add_argument("--backup", required=True, help="更新前バックアップの新規保存先")
    args = parser.parse_args()
    try:
        handlers = {"init": initialize, "install": install, "doctor": doctor, "start": start, "status": status, "admin": admin,
                    "backup": backup, "restore": restore, "update": update, "stop": stop, "logs": logs}
        if args.command in ("start", "stop", "admin", "backup", "update"):
            with operation_lock(Path(args.directory).resolve()):
                handlers[args.command](args)
        else:
            handlers[args.command](args)
    except (ValueError, KeyError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        # Do not print subprocess environments or credential-bearing file content.
        print(f"エラー: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
