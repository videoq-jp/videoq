import hashlib
import importlib.util
import io
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
        error = urllib.error.HTTPError(self.pin["url"], 404, "Not found", {}, None)
        with patch.object(managers.urllib.request, "urlopen", side_effect=error) as request, patch.object(managers.time, "sleep") as sleep:
            with self.assertRaises(urllib.error.HTTPError):
                managers.verified(self.pin)
        request.assert_called_once()
        sleep.assert_not_called()

    def test_certificate_failure_is_not_retried(self):
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
