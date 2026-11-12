import unittest
from types import SimpleNamespace
from unittest.mock import patch

from onprem_registry import check_public


class PublicRegistryTests(unittest.TestCase):
    def response(self, body, returncode=0):
        return patch("onprem_registry.subprocess.run", return_value=SimpleNamespace(stdout=body, returncode=returncode))

    def test_public_package_is_accepted(self):
        for component in ['api', 'transcription-gateway']:
            with self.response('{"visibility":"public"}') as request:
                check_public(component)
            self.assertEqual(request.call_args.args[0][-1], "orgs/videoq-jp/packages/container/" + ("videoq-" + component))

    def test_private_internal_and_missing_visibility_are_rejected(self):
        for body in ['{"visibility":"private"}', '{"visibility":"internal"}', '{}']:
            with self.subTest(body=body), self.response(body), self.assertRaises(RuntimeError):
                check_public("worker")

    def test_missing_packages_are_rejected_before_publication(self):
        with self.response('{"status":"404"}', 1):
            with self.assertRaises(RuntimeError):
                check_public("web")

    def test_auth_and_transport_errors_are_never_missing_packages(self):
        for body in ['{"status":"403"}', '{"status":"401"}', '', 'not JSON', '[]']:
            with self.subTest(body=body), self.response(body, 1), self.assertRaises(RuntimeError):
                check_public("api")

    def test_unknown_component_cannot_construct_a_package_path(self):
        with patch("onprem_registry.subprocess.run") as request, self.assertRaises(ValueError):
            check_public("../another-package")
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
