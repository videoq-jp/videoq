"""Installer safety and generated Compose configuration checks."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import tarfile
import io
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location("videoq", Path(__file__).with_name("videoq.py"))
videoq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(videoq)


class InstallerTests(unittest.TestCase):
    def test_resume_waits_for_health_without_compose_start_or_migrations(self):
        def state(health):
            return subprocess.CompletedProcess([], 0, stdout=json.dumps({"Running": True, "Health": {"Status": health}}) + "\n")
        with patch.object(videoq.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0), state("starting"), state("healthy")]) as run:
            with patch.object(videoq.time, "sleep") as sleep:
                videoq.resume_containers(["existing-container-id"])
        self.assertEqual(run.call_args_list[0].args[0], [*videoq.docker_command(), "start", "existing-container-id"])
        self.assertEqual(run.call_count, 3)
        sleep.assert_called_once_with(1)

    def test_resume_reports_a_health_timeout(self):
        unhealthy = subprocess.CompletedProcess([], 0, stdout=json.dumps({"Running": True, "Health": {"Status": "unhealthy"}}) + "\n")
        with patch.object(videoq.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0), unhealthy]):
            with self.assertRaisesRegex(ValueError, "準備状態"):
                videoq.resume_containers(["existing-container-id"], timeout=0)

    def values(self):
        return {name: {"image": {"repository": f"ghcr.io/videoq-jp/videoq-{name}", "digest": "sha256:" + "a" * 64}}
                for name in ("api", "web", "worker")}

    def test_rejects_non_origins_and_config_injection(self):
        for value in ("ftp://example.org", "https://u:p@example.org", "https://example.org/path",
                      "https://example.org?x=1", "https://example.org#fragment", "https://example.org\nfoo", "https://{$HOST}"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                videoq.origin(value)

    def test_origins_match_browser_normalization_for_cors(self):
        self.assertEqual(videoq.origin("https://VIDEOQ.Example.org:443/"), "https://videoq.example.org")
        self.assertEqual(videoq.origin("http://localhost:80"), "http://localhost")
        self.assertEqual(videoq.origin("http://[::1]:18090/"), "http://[::1]:18090")

    def test_rejects_mutable_image_references(self):
        values = self.values()
        values["api"]["image"]["digest"] = "latest"
        with self.assertRaises(ValueError):
            videoq.image_refs(values)
        for malformed in (None, [], {}, {"api": None}, {"api": {"image": {"repository": 123}}}):
            with self.subTest(value=malformed), self.assertRaises(ValueError):
                videoq.image_refs(malformed)

    def test_initialization_retains_keys_and_private_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            images = root / "images.json"
            images.write_text(json.dumps(self.values()))
            target = root / "installation"
            args = argparse.Namespace(images=str(images), directory=str(target), url="https://videoq.example.org", storage_url="https://s3.example.org")
            with patch.dict(os.environ, {"VIDEOQ_OPENROUTER_API_KEY": "test-only"}):
                videoq.initialize(args)
                previous = (target / "runtime.env").read_bytes()
                with self.assertRaises(FileExistsError):
                    videoq.initialize(args)
                self.assertEqual(previous, (target / "runtime.env").read_bytes())
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            for path in target.iterdir():
                self.assertEqual(path.stat().st_mode & 0o777, 0o644 if path.name in videoq.PUBLIC_FILES else 0o600)
            services = json.loads((target / "compose.json").read_text())["services"]
            for name, service in services.items():
                self.assertNotIn("build", service)
                if name != "gateway":
                    self.assertNotIn("ports", service)
            self.assertIn("queue_data:/data", services["queue"]["volumes"])
            self.assertEqual(services["worker"]["environment"]["R2_S3_ENDPOINT"], "http://garage:3900")
            self.assertIn("enabled = true", (target / "elasticmq.conf").read_text())

    def test_credentials_cannot_inject_env_lines(self):
        for value in ("foo\nBAR=secret", "x'y", "null\x00"):
            with self.assertRaises(ValueError):
                videoq.env_text({"KEY": value})

    def test_projects_are_isolated(self):
        refs = videoq.image_refs(self.values())
        first = videoq.compose(refs, "https://v.example", "https://s.example")
        second = videoq.compose(refs, "https://v.example", "https://s.example")
        self.assertNotEqual(first["name"], second["name"])

    def test_gateway_exposes_the_selected_public_ports(self):
        refs = videoq.image_refs(self.values())
        config = videoq.compose(refs, "http://localhost:18090", "http://localhost:18091", "127.0.0.1")
        self.assertEqual(config["services"]["gateway"]["ports"], ["127.0.0.1:18090:18090", "127.0.0.1:18091:18091"])
        tls = videoq.compose(refs, "https://v.example", "https://s.example")
        self.assertEqual(tls["services"]["gateway"]["ports"], ["80:80", "443:443", "443:443/udp"])

    def test_backup_rejects_traversal_and_modified_data(self):
        for member_name in ("../outside", "/outside", "postgres_data/../../outside"):
            with self.subTest(name=member_name), tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary)
                config = source / "configuration"
                config.mkdir()
                (config / "compose.json").write_text(json.dumps({"volumes": {"postgres_data": {}}}))
                for name in ("runtime.env", "postgres.env", "garage.env"):
                    (config / name).write_text("test")
                with tarfile.open(source / "volumes.tgz", "w:gz") as archive:
                    member = tarfile.TarInfo(member_name)
                    member.size = 1
                    archive.addfile(member, io.BytesIO(b"x"))
                manifest = {"version": 1, "files": {str(p.relative_to(source)): videoq.checksum(p)
                                                     for p in source.rglob("*") if p.is_file()}}
                (source / "backup.json").write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    videoq.verify_backup(source)
                (config / "runtime.env").write_text("modified")
                with self.assertRaisesRegex(ValueError, "チェックサム"):
                    videoq.verify_backup(source)

    def test_operation_lock_excludes_overlapping_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            with videoq.operation_lock(Path(temporary)):
                with self.assertRaisesRegex(ValueError, "別の操作"):
                    with videoq.operation_lock(Path(temporary)):
                        self.fail("overlapping lock acquired")

    def test_update_download_failure_does_not_stop_or_change_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = videoq.compose(videoq.image_refs(self.values()), "https://v.example", "https://s.example")
            (root / "compose.json").write_text(json.dumps(config))
            (root / "images.json").write_text(json.dumps(self.values()))
            args = argparse.Namespace(directory=str(root), images=str(root / "images.json"), backup=str(root.parent / "unused-backup"))
            with patch.object(videoq.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["docker", "pull"])):
                with patch.object(videoq, "backup_directory") as snapshot:
                    with self.assertRaises(subprocess.CalledProcessError):
                        videoq.update(args)
                    snapshot.assert_not_called()
            self.assertEqual(json.loads((root / "compose.json").read_text()), config)

    def test_local_ai_has_no_hosted_defaults_or_key_prompt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "images.json").write_text(json.dumps(self.values()))
            args = argparse.Namespace(directory=str(root / "local"), images=str(root / "images.json"),
                                      url="https://v.example", storage_url="https://s.example", ai="local-cpu",
                                      chat_url="http://chat:8000/v1", embedding_url="http://embedding:8000/v1",
                                      transcription_url="http://whisper:8080/v1")
            with patch.object(videoq.getpass, "getpass", side_effect=AssertionError("unexpected prompt")):
                videoq.initialize(args)
            environment = (root / "local/runtime.env").read_text()
            self.assertNotIn("openrouter", environment.lower())
            self.assertIn("WHISPER_BACKEND='local'", environment)
            self.assertIn("LLM_SEPARATE_TOOL_SCHEMA='true'", environment)

    def test_failed_update_preserves_snapshot_and_stops_application(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "compose.json").write_text(json.dumps(videoq.compose(videoq.image_refs(self.values()), "https://v.example", "https://s.example")))
            (root / "images.json").write_text(json.dumps(self.values()))
            args = argparse.Namespace(directory=str(root), images=str(root / "images.json"), backup=str(root.parent / "pre-update"))
            with patch.object(videoq.subprocess, "run"), patch.object(videoq, "backup_directory") as snapshot:
                with patch.object(videoq, "start", side_effect=ValueError("migration failed")), patch.object(videoq, "docker") as docker:
                    with self.assertRaisesRegex(ValueError, "migration failed"):
                        videoq.update(args)
                    snapshot.assert_called_once_with(root, Path(args.backup), resume=False)
                    docker.assert_called_once_with(root, "stop", "gateway", "api", "worker", "scheduler", "web")
            self.assertTrue((root / "compose.json").is_file())


if __name__ == "__main__":
    unittest.main()
