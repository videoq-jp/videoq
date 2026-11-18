import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest


spec = importlib.util.spec_from_file_location("headers", Path(__file__).with_name("check-upstream-header-image.py"))
headers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(headers)


def filesystem(*extra, architecture="arm64", paths=None, version="5.15.0-198.208"):
    output = io.BytesIO()
    paths = paths if paths is not None else ["/.", "/usr/include/linux/types.h", "/usr/share/doc/linux-libc-dev/copyright"]
    rows = [
        ("var/lib/dpkg/status", f"Package: linux-libc-dev\nStatus: install ok installed\nArchitecture: {architecture}\nVersion: {version}\n\n".encode(), 0o644),
        (f"var/lib/dpkg/info/linux-libc-dev:{architecture}.list", "\n".join(paths).encode(), 0o644),
        ("usr/include/linux/types.h", b"typedef int example;", 0o644),
        ("usr/share/doc/linux-libc-dev/copyright", b"license", 0o644),
        *extra,
    ]
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, data, mode in rows:
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), mode
            archive.addfile(info, io.BytesIO(data))
    output.seek(0)
    return output


class HeaderImageTests(unittest.TestCase):
    def test_non_native_archive_is_checked_without_execution(self):
        result = headers.inventory(filesystem(), "arm64")
        self.assertEqual(result["architecture"], "arm64")
        self.assertEqual(result["files"], 2)
        self.assertEqual(result["version"], "5.15.0-198.208")

    def test_changed_header_content_changes_the_review_identity(self):
        baseline = headers.inventory(filesystem(), "arm64")
        changed = headers.inventory(filesystem(("usr/include/linux/types.h", b"changed", 0o644)), "arm64")
        self.assertNotEqual(baseline["inventorySha256"], changed["inventorySha256"])

    def test_executable_code_and_kernel_artifacts_are_rejected(self):
        for row in [("usr/include/linux/code.h", b"\x7fELFcode", 0o644),
                    ("usr/include/linux/code.h", b"#!/bin/sh", 0o755),
                    ("boot/vmlinuz-test", b"kernel", 0o644),
                    ("usr/lib/modules/test/driver.ko.xz", b"module", 0o644)]:
            with self.subTest(path=row[0]), self.assertRaisesRegex(ValueError, "Executable|binaries/modules"):
                headers.inventory(filesystem(row), "arm64")

    def test_missing_or_unassessed_owned_files_are_rejected(self):
        for paths in [["/usr/include/missing.h"], ["/var/lib/dpkg/status"], []]:
            with self.subTest(paths=paths), self.assertRaisesRegex(ValueError, "missing|Unassessed|metadata"):
                headers.inventory(filesystem(paths=paths), "arm64")

    def test_wrong_architecture_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "metadata"):
            headers.inventory(filesystem(architecture="amd64"), "arm64")

    def test_archive_and_package_traversal_are_rejected(self):
        for row in [("../outside", b"data", 0o644), ("/outside", b"data", 0o644)]:
            with self.subTest(path=row[0]), self.assertRaisesRegex(ValueError, "Unsafe"):
                headers.inventory(filesystem(row), "arm64")
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            headers.inventory(filesystem(paths=["/usr/include/../../outside"]), "arm64")

    def test_assessment_stays_scoped_to_two_reviewed_packages_and_explicit_cves(self):
        root = Path(__file__).resolve().parents[2] / "apps/inference/whispercpp/security"
        approved = json.loads((root / "header-image-inventory.json").read_text())["images"]
        self.assertEqual(set(approved), {"amd64", "arm64"})
        expected = [{"@id": f"pkg:deb/ubuntu/linux-libc-dev@{approved[arch]['version']}?arch={arch}&distro=ubuntu-22.04"}
                    for arch in ("amd64", "arm64")]
        statements = json.loads((root / "kernel-headers.openvex.json").read_text())["statements"]
        self.assertEqual(len(statements), 536)
        self.assertTrue({'CVE-2026-72463', 'CVE-2026-74753'}.issubset({s['vulnerability']['name'] for s in statements}))
        self.assertEqual(len({row["vulnerability"]["name"] for row in statements}), len(statements))
        for row in statements:
            self.assertRegex(row["vulnerability"]["name"], r"^CVE-\d{4}-\d+$")
            self.assertEqual(row["products"], expected)
            self.assertEqual(row["status"], "not_affected")
            self.assertEqual(row["justification"], "vulnerable_code_not_present")


if __name__ == "__main__":
    unittest.main()
