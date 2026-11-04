"""Opt-in real registry, video, update failure and recovery acceptance.

Uses production application images, deterministic AI, a loopback-only temporary
registry and Chromium. No production registry or AI credentials are used.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import tempfile
import time
import unittest
from urllib.request import urlopen
from urllib.error import HTTPError
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("videoq", Path(__file__).with_name("videoq.py"))
videoq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(videoq)
REGISTRY = "registry:3@sha256:d4032d4cc323c1731c707931ecada07a53076eac38e3b61ae57533f170f2c6c3"


@unittest.skipUnless(os.environ.get("VIDEOQ_ONPREM_ACCEPTANCE") == "1", "opt-in registry/video acceptance")
class AcceptanceTest(unittest.TestCase):
    def test_custom_certificate_served_by_gateway(self):
        with tempfile.TemporaryDirectory(prefix="videoq-installer-tls-") as temporary:
            root = Path(temporary)
            certificate, key = root / "site.crt", root / "site.key"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", str(key),
                            "-out", str(certificate)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            values = {c: {"image": {"repository": f"videoq-{c}", "digest": "sha256:" + "a" * 64}}
                      for c in ("api", "worker", "web")}
            (root / "images.json").write_text(json.dumps(values))
            server = root / "server"
            args = argparse.Namespace(directory=str(server), images=str(root / "images.json"), url="https://localhost:18094",
                                      storage_url="https://localhost:18095", tls_cert=str(certificate), tls_key=str(key))
            with patch.dict(os.environ, {"VIDEOQ_OPENROUTER_API_KEY": "tls-no-provider-calls"}):
                videoq.initialize(args)
            config = json.loads((server / "compose.json").read_text())
            gateway = config["services"]["gateway"]
            # The generated gateway serves its real certificate; backends are
            # deliberately absent, so HTTP 502 proves TLS and routing completed.
            gateway.pop("depends_on")
            gateway["ports"] = ["127.0.0.1:18094:18094", "127.0.0.1:18095:18095"]
            config["services"] = {"gateway": gateway}
            (server / "compose.json").write_text(json.dumps(config))
            try:
                videoq.docker(server, "up", "-d", "--wait")
                context = ssl.create_default_context(cafile=str(certificate))
                for port in (18094, 18095):
                    for attempt in range(30):
                        try:
                            urlopen(f"https://localhost:{port}/ready", context=context, timeout=3)
                            self.fail("missing backend should return 502")
                        except HTTPError as error:
                            self.assertEqual(error.code, 502)
                            break
                        except OSError:
                            if attempt == 29:
                                raise
                            time.sleep(0.25)
            finally:
                videoq.docker(server, "down", "--volumes", "--remove-orphans")

    def test_video_update_and_failed_migration_recovery(self):
        with tempfile.TemporaryDirectory(prefix="videoq-installer-acceptance-") as temporary:
            root = Path(temporary)
            server, recovered, fresh = root / "server", root / "recovered", root / "fresh"
            registry_name = "videoq-installer-registry-" + secrets.token_hex(6)
            tags = []

            def engine(*arguments, **kwargs):
                return subprocess.run([*videoq.docker_command(), *arguments], check=True, **kwargs)

            def publish(source, component, tag):
                repository = f"127.0.0.1:18092/{registry_name}/{component}"
                reference = repository + ":" + tag
                tags.append(reference)
                engine("tag", source, reference)
                engine("push", reference, stdout=subprocess.DEVNULL)
                digests = json.loads(engine("image", "inspect", reference, "--format", "{{json .RepoDigests}}", capture_output=True, text=True).stdout)
                digest = next(value.split("@", 1)[1] for value in digests if value.startswith(repository + "@"))
                return {"image": {"repository": repository, "digest": digest}}

            def flow(mode, fixture=None):
                subprocess.run([os.environ.get("VIDEOQ_LAB_NODE", "node"), str(Path(__file__).with_name("acceptance.mjs")),
                                mode, str(root / "state.json"), *([str(fixture)] if fixture else [])], check=True,
                               cwd=videoq.ROOT, timeout=240)

            try:
                engine("run", "-d", "--name", registry_name, "-p", "127.0.0.1:18092:5000", REGISTRY, stdout=subprocess.DEVNULL)
                for attempt in range(60):
                    try:
                        with urlopen("http://127.0.0.1:18092/v2/", timeout=2):
                            break
                    except OSError:
                        if attempt == 59:
                            raise
                        time.sleep(0.5)
                sources = {c: os.environ.get(f"VIDEOQ_ONPREM_{c.upper()}_IMAGE", f"videoq-{c}:onprem-ci") for c in ("api", "worker", "web")}
                values = {c: publish(sources[c], c, "initial") for c in sources}
                images = root / "initial.json"
                images.write_text(json.dumps(values))
                args = argparse.Namespace(directory=str(server), images=str(images), url="http://localhost:18090",
                                          storage_url="http://localhost:18091", ai="local-gpu", chat_url="http://inference:8080/v1",
                                          embedding_url="http://inference:8080/v1", transcription_url="http://inference:8080/v1", offline=True)
                videoq.initialize(args)
                config_path = server / "compose.json"
                config = json.loads(config_path.read_text())
                config["services"]["gateway"]["ports"] = ["127.0.0.1:18090:18090", "127.0.0.1:18091:18091"]
                fixture_source = videoq.ROOT / ".github/onprem-lab/inference.mjs"
                (server / "inference.mjs").write_text(fixture_source.read_text())
                (server / "inference.mjs").chmod(0o644)
                config["services"]["inference"] = {"image": videoq.image_refs(values)["api"], "command": ["node", "/inference.mjs"],
                                                       "volumes": ["./inference.mjs:/inference.mjs:ro"], "restart": "unless-stopped"}
                config_path.write_text(json.dumps(config))
                videoq.start(args)
                activation = videoq.docker(server, "exec", "-T", "api", "node", "dist/provision-user.mjs", "--admin",
                                           "--username", "onprem_lab", "--email", "onprem-lab@example.com", capture_output=True, text=True)
                videoq.write_private(root / "state.json", activation.stdout)
                flow("activate")
                fixture = root / "fixture.mp4"
                with fixture.open("xb") as stream:
                    engine("run", "--rm", "--entrypoint", "ffmpeg", sources["worker"], "-hide_banner", "-loglevel", "error",
                           "-f", "lavfi", "-i", "color=c=black:s=160x120:r=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
                           "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1", stdout=stream)
                flow("upload", fixture)
                build = root / "build"
                build.mkdir()
                upgrade_image = f"{registry_name}-api:upgrade"
                broken_image = f"{registry_name}-api:broken"
                tags.extend([upgrade_image, broken_image])
                (build / "Dockerfile").write_text(f"FROM {sources['api']}\nLABEL io.videoq.acceptance=upgrade\n")
                engine("build", "-t", upgrade_image, str(build), stdout=subprocess.DEVNULL)
                upgraded = {**values, "api": publish(upgrade_image, "api", "upgrade")}
                (root / "upgrade.json").write_text(json.dumps(upgraded))
                videoq.update(argparse.Namespace(directory=str(server), images=str(root / "upgrade.json"), backup=str(root / "before-upgrade")))
                flow("after-upgrade")
                # A real non-zero migration process, without mocking installer calls.
                (build / "Dockerfile").write_text(f"FROM {sources['api']}\nUSER root\nRUN printf '#!/bin/sh\\nexit 42\\n' > scripts/db-migrate.sh\nUSER node\n")
                engine("build", "-t", broken_image, str(build), stdout=subprocess.DEVNULL)
                broken = {**upgraded, "api": publish(broken_image, "api", "broken")}
                (root / "broken.json").write_text(json.dumps(broken))
                with self.assertRaises(subprocess.CalledProcessError):
                    videoq.update(argparse.Namespace(directory=str(server), images=str(root / "broken.json"), backup=str(root / "before-failure")))
                running = videoq.docker(server, "ps", "--status", "running", "--services", capture_output=True, text=True).stdout.split()
                self.assertFalse(set(running) & {"gateway", "api", "worker", "scheduler", "web"})
                videoq.verify_backup(root / "before-failure")
                videoq.stop(args)
                videoq.docker(server, "stop", "inference")
                videoq.restore(argparse.Namespace(directory=str(recovered), backup=str(root / "before-failure")))
                # Custom test fixture is not an installer-managed public script.
                (recovered / "inference.mjs").chmod(0o644)
                videoq.start(argparse.Namespace(directory=str(recovered), offline=True))
                videoq.doctor(argparse.Namespace(directory=str(recovered), live=True, ai=False))
                flow("after-failed-update-restore")
                videoq.stop(argparse.Namespace(directory=str(recovered)))
                # Exercise the public one-command CLI as a fresh installation,
                # capturing its intentionally secret account setup URL.
                installed = subprocess.run([
                    "python3", str(Path(__file__).with_name("videoq.py")), "--directory", str(fresh), "install",
                    "--images", str(root / "upgrade.json"), "--url", "http://localhost:18090",
                    "--storage-url", "http://localhost:18091", "--bind-address", "127.0.0.1", "--ai", "local-gpu",
                    "--chat-url", "http://inference:8080/v1", "--embedding-url", "http://inference:8080/v1",
                    "--transcription-url", "http://inference:8080/v1", "--username", "fresh_admin", "--email", "fresh-admin@example.com",
                ], check=True, capture_output=True, text=True, timeout=240)
                account = json.loads(installed.stdout.strip().splitlines()[-1])
                self.assertEqual(account["username"], "fresh_admin")
                self.assertTrue(account["activation_url"].startswith("http://localhost:18090/api/auth/"))
                print("Public install command completed setup, infrastructure diagnostics and administrator provisioning")
            finally:
                for directory in (fresh, recovered, server):
                    if (directory / "compose.json").exists():
                        videoq.docker(directory, "down", "--timeout", "30", "--volumes", "--remove-orphans")
                subprocess.run([*videoq.docker_command(), "rm", "-f", registry_name], check=False, stdout=subprocess.DEVNULL)
                if tags:
                    subprocess.run([*videoq.docker_command(), "image", "rm", *tags], check=False, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    unittest.main()
