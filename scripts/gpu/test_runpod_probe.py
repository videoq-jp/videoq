"""Probe refusal, process cleanup and HTTP contracts; no GPU/model acceptance."""
import copy
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("runpod-rtx4090-probe.py"))
probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_refuses_dirty_or_different_probe_source(self):
        plan = {"schema": 1, "scope": "one-container-three-process-preliminary-probe-not-k3s", "sourceDirty": False,
                "runnerSha256": hashlib.sha256(Path(probe.__file__).read_bytes()).hexdigest(),
                "roles": {role: {"command": ["vllm", "serve", "/models/" + "a" * 40], "image": "ghcr.io/videoq-jp/videoq-vllm@sha256:" + "b" * 64, "model": {"repo": "Qwen/Test", "revision": "a" * 40, "file": "", "sha256": ""}} for role in probe.PORTS}}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.json"; path.write_text(json.dumps(plan))
            self.assertEqual(probe.read_plan(path)["scope"], plan["scope"])
            for key, value in [("sourceDirty", True), ("runnerSha256", "wrong"), ("scope", "k3s-accepted")]:
                bad = copy.deepcopy(plan); bad[key] = value; path.write_text(json.dumps(bad))
                with self.assertRaises(ValueError): probe.read_plan(path)

    def test_only_adapts_private_listener_and_model_path(self):
        config = {"model": {"revision": "a" * 40}, "command": ["vllm", "serve", "/models/" + "a" * 40, "--port", "8000", "--host", "0.0.0.0", "--gpu-memory-utilization", "0.43"]}
        original = copy.deepcopy(config)
        command = probe.model_command("embedding", config, Path("/workspace/models"))
        self.assertEqual(command, ["vllm", "serve", "/workspace/models/" + "a" * 40, "--port", "8001", "--host", "127.0.0.1", "--gpu-memory-utilization", "0.43"])
        self.assertEqual(config, original)

    def test_cleanup_terminates_only_owned_process_group(self):
        child = subprocess.Popen(["python3", "-c", "import time; time.sleep(60)"], start_new_session=True)
        try:
            probe.stop_processes([child])
            self.assertIsNotNone(child.poll())
        finally:
            if child.poll() is None: child.kill(); child.wait()

    def test_readiness_rejects_unhealthy_http_before_accepting_200(self):
        class Handler(BaseHTTPRequestHandler):
            calls = 0
            def do_GET(self):
                Handler.calls += 1
                self.send_response(503 if Handler.calls == 1 else 200); self.end_headers()
            def log_message(self, *_args): pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        child = subprocess.Popen(["python3", "-c", "import time; time.sleep(60)"], start_new_session=True)
        try:
            probe.wait_ready(child, server.server_port, time.monotonic() + 5)
            self.assertEqual(Handler.calls, 2)
        finally:
            probe.stop_processes([child]); server.shutdown(); server.server_close(); thread.join()

    def test_http_contracts_validate_vectors_japanese_chat_and_speech_timestamps(self):
        class Handler(BaseHTTPRequestHandler):
            dimensions = 1536
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                if self.path == "/v1/embeddings": payload = {"data": [{"embedding": [.01] * Handler.dimensions}]}
                elif self.path == "/v1/chat/completions": payload = {"choices": [{"message": {"content": "東京です。"}}]}
                elif self.path == "/v1/audio/transcriptions": payload = {"text": "東京", "segments": [{"start": 0, "end": 1, "text": "東京"}]}
                else: self.send_error(404); return
                self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(payload).encode())
            def log_message(self, *_args): pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        previous = probe.PORTS
        probe.PORTS = {role: server.server_port for role in previous}
        try:
            case = {"reference": "東京", "duration": 1, "regions": []}
            self.assertEqual(probe.smoke("embedding", b"http-contract-fixture", case, "embedding")["dimensions"], 1536)
            self.assertIn("東京", probe.smoke("chat", b"http-contract-fixture", case, "chat")["text"])
            self.assertEqual(probe.smoke("whisper", b"http-contract-fixture", case, "speech")["cer"], 0)
            Handler.dimensions = 1024
            with self.assertRaises(ValueError): probe.smoke("embedding", b"http-contract-fixture", case, "embedding")
        finally:
            probe.PORTS = previous; server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__": unittest.main()
