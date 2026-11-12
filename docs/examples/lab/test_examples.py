"""Offline contract checks; these do not substitute for the real GPU acceptance."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
import urllib.request

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("lab_smoke", HERE / "smoke-test.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class Response(io.BytesIO):
    def __init__(self, value, status=200):
        super().__init__(
            value if isinstance(value, bytes) else json.dumps(value).encode()
        )
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class Examples(unittest.TestCase):
    def smoke_run(self, answer, upload_url="/upload", origin="https://192.168.1.50"):
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            policy = json.loads((HERE / "smoke-policy.example.json").read_text())
            policy["public_url"] = origin
            (root / "policy.json").write_text(json.dumps(policy))
            (root / "smoke-credentials.json").write_text(
                json.dumps(
                    {"email": "fixture@example.com", "password": "fake-unit-test-only"}
                )
            )
            (root / "fixture.mp4").write_bytes(b"fake-unit-test-video")

            def opened(req, timeout):
                path = req.selector.split("?")[0]
                body = (
                    json.loads(req.data)
                    if req.data
                    and req.headers.get("Content-type") == "application/json"
                    else None
                )
                calls.append((path, req.get_method(), body))
                if path == "/ready":
                    return Response({"data": {"db": "ok"}})
                if path == "/api/auth/sign-in/email":
                    return Response({})
                if path == "/upload":
                    return Response(b"")
                if path == "/media":
                    return Response(b"0123456789abcdef", 206)
                if path == "/api/chat/messages/stream":
                    return Response(
                        b'data: {"type":"citation"}\n\ndata: {"type":"done"}\n\n'
                    )
                name = path.removeprefix("/api/trpc/")
                result = {
                    "videos.requestUpload": {
                        "video": {"id": 77},
                        "upload_url": upload_url,
                    },
                    "videos.confirmUpload": {},
                    "videos.get": {
                        "id": 77,
                        "status": "completed",
                        "transcript": "画像処理のアルゴリズムを説明します",
                        "file": "/media",
                    },
                    "courses.create": {"id": 88},
                    "memberships.addVideo": {},
                    "chat.send": {
                        "answer": {
                            "segments": [{"text": answer, "sourceIds": [1]}],
                            "sources": [
                                {"id": 1, "video_id": 77, "start_time": "00:00:00,000"}
                            ],
                        }
                    },
                    "courses.delete": {},
                    "videos.delete": {},
                }[name]
                return Response({"result": {"data": result}})

            with (
                patch.object(smoke, "ROOT", root),
                patch(
                    "sys.argv", ["smoke-test", "--policy", str(root / "policy.json")]
                ),
                patch.object(smoke.ssl, "create_default_context"),
                patch.object(
                    smoke.http.cookiejar, "CookieJar", return_value=[object()]
                ),
                patch.object(smoke.urllib.request, "build_opener") as build,
                contextlib.redirect_stdout(io.StringIO()),
            ):
                build.return_value.open.side_effect = opened
                try:
                    smoke.main()
                    error = None
                except RuntimeError as exc:
                    error = str(exc)
        return calls, error

    def test_japanese_and_english_pass_and_only_created_resources_deleted(self):
        for answer in [
            "画像処理のアルゴリズムを説明しています。",
            "Image-processing algorithms run on a computer.",
        ]:
            with self.subTest(answer=answer):
                calls, error = self.smoke_run(answer)
                self.assertIsNone(error)
                deletes = [
                    (path, body) for path, _, body in calls if path.endswith(".delete")
                ]
                self.assertEqual(
                    deletes,
                    [
                        ("/api/trpc/courses.delete", {"id": 88}),
                        ("/api/trpc/videos.delete", {"id": 77}),
                    ],
                )

    def test_unrelated_answer_fails_and_retains_test_data(self):
        calls, error = self.smoke_run("This describes a cooking recipe.")
        self.assertIn("Unexpected answer", error)
        self.assertFalse(any(path.endswith(".delete") for path, _, _ in calls))

    def test_upload_cannot_send_video_or_cookies_to_another_origin(self):
        calls, error = self.smoke_run(
            "画像処理のアルゴリズム", "https://outside.example/upload"
        )
        self.assertEqual(error, "Unexpected request origin")
        self.assertFalse(any(method == "PUT" for _, method, _ in calls))

    def test_plain_http_policy_rejected_before_login(self):
        calls, error = self.smoke_run("", origin="http://192.168.1.50")
        self.assertEqual(error, "Invalid HTTPS public_url")
        self.assertEqual(calls, [])

    def test_cross_origin_redirect_rejected(self):
        smoke.ORIGIN = "https://192.168.1.50"
        with self.assertRaisesRegex(RuntimeError, "Unexpected redirect"):
            smoke.LocalRedirect().redirect_request(
                urllib.request.Request(smoke.ORIGIN),
                None,
                302,
                "",
                {},
                "https://outside.example/",
            )

    def test_forgejo_render_only_and_port_bindings(self):
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch(
                "sys.argv",
                [
                    "forgejo-bootstrap",
                    "--listen-ip",
                    "192.168.1.50",
                    "--directory",
                    tmp,
                ],
            ),
            patch("os.chown"),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            runpy.run_path(str(HERE / "forgejo-bootstrap.py"), run_name="__main__")
            data = json.loads((Path(tmp) / "manifest.json").read_text())
            container = data["items"][1]["spec"]["template"]["spec"]["containers"][0]
            ports = {
                item["containerPort"]: item["hostIP"] for item in container["ports"]
            }
            self.assertEqual(ports, {3000: "127.0.0.1", 2222: "192.168.1.50"})
            self.assertIn("@sha256:", container["image"])
            self.assertFalse(
                data["items"][1]["spec"]["template"]["spec"][
                    "automountServiceAccountToken"
                ]
            )


if __name__ == "__main__":
    unittest.main()
