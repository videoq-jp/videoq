import hashlib
import importlib.util
import io
import json
from pathlib import Path
import ssl
import unittest
import urllib.error
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("package_managers_download_test", Path(__file__).with_name("package-managers.py"))
managers = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(managers)


class VerifiedDownloadTests(unittest.TestCase):
    def setUp(self):
        self.body = b"checksum-pinned distribution"
        self.pin = {"url": "https://example.invalid/tool.tar.gz", "sha256": hashlib.sha256(self.body).hexdigest()}

    def gateway_error(self):
        return urllib.error.HTTPError(self.pin["url"], 504, "Gateway timeout", {}, None)

    def github_pin(self):
        self.pin["url"] = "https://github.com/astral-sh/uv/releases/download/0.13.7/uv-x86_64-unknown-linux-gnu.tar.gz"
        return {"tag_name": "0.13.7", "assets": [{"id": 123, "name": "uv-x86_64-unknown-linux-gnu.tar.gz",
                "browser_download_url": "https://untrusted.invalid/archive"}]}

    def test_persistent_release_gateway_failure_uses_exact_official_asset_and_checks_hash(self):
        release = self.github_pin()
        replies = [self.gateway_error() for _ in range(2)] + [io.BytesIO(json.dumps(release).encode()), io.BytesIO(self.body)]
        with patch.object(managers.urllib.request, "urlopen", side_effect=replies) as request, patch.object(managers.time, "sleep"):
            self.assertEqual(managers.verified(self.pin), self.body)
        self.assertEqual(request.call_count, 4)
        self.assertEqual(request.call_args_list[2].args[0].full_url, "https://api.github.com/repos/astral-sh/uv/releases/tags/0.13.7")
        asset = request.call_args_list[3].args[0]
        self.assertEqual(asset.full_url, "https://api.github.com/repos/astral-sh/uv/releases/assets/123")
        self.assertEqual(asset.get_header("Accept"), "application/octet-stream")

    def test_fallback_rejects_wrong_tag_ambiguous_assets_and_non_numeric_ids(self):
        for variant in ("tag", "ambiguous", "id", "missing"):
            with self.subTest(variant=variant):
                release = self.github_pin()
                if variant == "tag":
                    release["tag_name"] = "0.13.8"
                elif variant == "ambiguous":
                    release["assets"] *= 2
                elif variant == "id":
                    release["assets"][0]["id"] = "../other"
                else:
                    release["assets"] = []
                replies = [self.gateway_error() for _ in range(2)] + [io.BytesIO(json.dumps(release).encode())]
                with patch.object(managers.urllib.request, "urlopen", side_effect=replies) as request, patch.object(managers.time, "sleep"):
                    with self.assertRaisesRegex(ValueError, "Unexpected GitHub release"):
                        managers.verified(self.pin)
                self.assertEqual(request.call_count, 3)

    def test_fallback_bytes_must_match_the_committed_checksum(self):
        release = self.github_pin()
        replies = [self.gateway_error() for _ in range(2)] + [io.BytesIO(json.dumps(release).encode()), io.BytesIO(b"tampered")]
        with patch.object(managers.urllib.request, "urlopen", side_effect=replies) as request, patch.object(managers.time, "sleep"):
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                managers.verified(self.pin)
        self.assertEqual(request.call_count, 4)

    def test_recovers_from_gateway_failure_and_verifies_the_retried_bytes(self):
        with patch.object(managers.urllib.request, "urlopen", side_effect=[self.gateway_error(), io.BytesIO(self.body)]) as request, patch.object(managers.time, "sleep") as sleep:
            self.assertEqual(managers.verified(self.pin), self.body)
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_retries_timeouts_and_connection_resets_with_a_bounded_backoff(self):
        with patch.object(managers.urllib.request, "urlopen", side_effect=[TimeoutError(), ConnectionResetError(), io.BytesIO(self.body)]), patch.object(managers.time, "sleep") as sleep:
            self.assertEqual(managers.verified(self.pin), self.body)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])

    def test_stops_after_four_failed_downloads(self):
        with patch.object(managers.urllib.request, "urlopen", side_effect=[self.gateway_error() for _ in range(4)]) as request, patch.object(managers.time, "sleep") as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                managers.verified(self.pin)
        self.assertEqual(request.call_count, 4)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2, 4])

    def test_not_found_is_not_retried(self):
        self.github_pin()
        error = urllib.error.HTTPError(self.pin["url"], 404, "Not found", {}, None)
        with patch.object(managers.urllib.request, "urlopen", side_effect=error) as request, patch.object(managers.time, "sleep") as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                managers.verified(self.pin)
        request.assert_called_once()
        sleep.assert_not_called()

    def test_certificate_failure_is_not_retried(self):
        self.github_pin()
        error = urllib.error.URLError(ssl.SSLCertVerificationError(1, "Untrusted certificate"))
        with patch.object(managers.urllib.request, "urlopen", side_effect=error) as request, patch.object(managers.time, "sleep") as sleep:
            with self.assertRaises(urllib.error.URLError):
                managers.verified(self.pin)
        request.assert_called_once()
        sleep.assert_not_called()

    def test_hash_mismatch_after_retry_is_fatal_without_further_downloads(self):
        with patch.object(managers.urllib.request, "urlopen", side_effect=[self.gateway_error(), io.BytesIO(b"tampered")]) as request, patch.object(managers.time, "sleep") as sleep:
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                managers.verified(self.pin)
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(1)


if __name__ == "__main__":
    unittest.main()
