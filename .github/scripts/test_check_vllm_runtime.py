"""Offline tests; native serving probes run only in the pinned hosted image."""
import hashlib
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("vllm_runtime_probe", Path(__file__).with_name("check-vllm-runtime.py"))
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class SourceIdentityTests(unittest.TestCase):
    def test_exact_member_and_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "module.py"
            path.write_bytes(b"reviewed source")
            expected = {"module.py": hashlib.sha256(path.read_bytes()).hexdigest()}
            self.assertEqual(PROBE.verify_reviewed_files(directory, expected), expected)
            path.write_bytes(b"changed native/source member")
            with self.assertRaisesRegex(ValueError, "Unreviewed installed"):
                PROBE.verify_reviewed_files(directory, expected)

    def test_missing_member_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                PROBE.verify_reviewed_files(directory, {"missing.so": "0" * 64})

    def test_symlink_outside_root_fails_before_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "package"
            root.mkdir()
            other = Path(directory) / "other"
            other.write_bytes(b"outside")
            (root / "member").symlink_to(other)
            with self.assertRaisesRegex(ValueError, "escaped"):
                PROBE.verify_reviewed_files(root, {"member": hashlib.sha256(b"outside").hexdigest()})

    def test_loaded_library_mappings_reject_an_alternate_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            maps = root / "maps"
            good = root / "av.libs/libavcodec-reviewed.so.63"
            good.parent.mkdir()
            good.write_bytes(b"reviewed native fixture")
            expected = {"av.libs/" + good.name: hashlib.sha256(good.read_bytes()).hexdigest()}
            maps.write_text(f"1000-2000 r-xp 0 00:00 0 {good}\n")
            with patch.dict(PROBE.REVIEWED_PYAV_MEMBERS, expected, clear=True):
                self.assertEqual(PROBE.loaded_ffmpeg_libraries(root, maps), [str(good)])
            maps.write_text("1000-2000 r-xp 0 00:00 0 /base/torchcodec/libavcodec.so.63\n")
            with self.assertRaisesRegex(ValueError, "Unreviewed loaded"):
                PROBE.loaded_ffmpeg_libraries(root, maps)
            maps.write_text("1000-2000 r-xp 0 00:00 0 /lib/libc.so.6\n")
            with self.assertRaisesRegex(ValueError, "No actual FFmpeg"):
                PROBE.loaded_ffmpeg_libraries(root, maps)

    def test_mapped_members_require_existing_regular_exact_reviewed_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            libs = root / "av.libs"
            libs.mkdir()
            good = libs / "libavcodec-reviewed.so.63"
            good.write_bytes(b"reviewed fixture")
            expected = {"av.libs/" + good.name: hashlib.sha256(good.read_bytes()).hexdigest()}
            maps = root / "maps"
            unknown = libs / "libavcodec-unreviewed.so.999"
            unknown.write_bytes(good.read_bytes())
            alias = libs / "libavcodec-alias.so.63"
            alias.symlink_to(good)
            folder = libs / "libavcodec-directory.so"
            folder.mkdir()
            cases = [str(unknown), str(libs / "libavcodec-missing.so"), str(good) + " (deleted)",
                     str(alias), str(folder), str(libs) + "/../av.libs/" + good.name]
            with patch.dict(PROBE.REVIEWED_PYAV_MEMBERS, expected, clear=True):
                for value in cases:
                    with self.subTest(value=value):
                        maps.write_text(f"1000-2000 r-xp 0 00:00 0 {value}\n")
                        with self.assertRaisesRegex(ValueError, "Unreviewed loaded"):
                            PROBE.loaded_ffmpeg_libraries(root, maps)
                maps.write_text(f"1000-2000 r-xp 0 00:00 0 {good}\n")
                good.write_bytes(b"changed hash")
                with self.assertRaisesRegex(ValueError, "Unreviewed loaded"):
                    PROBE.loaded_ffmpeg_libraries(root, maps)
                good.unlink()
                good.symlink_to(unknown)
                with self.assertRaisesRegex(ValueError, "Unreviewed loaded"):
                    PROBE.loaded_ffmpeg_libraries(root, maps)

    def test_pins_include_native_extensions_and_reviewed_source(self):
        for name in ("audio/resampler", "filter/graph", "filter/context", "container/core"):
            self.assertIn(f"av/{name}.py", PROBE.REVIEWED_PYAV_MEMBERS)
            self.assertIn(f"av/{name}.abi3.so", PROBE.REVIEWED_PYAV_MEMBERS)
        self.assertIn("vllm/entrypoints/speech_to_text/base/serving.py", PROBE.REVIEWED_VLLM_SOURCES)


class NativeBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.native = SimpleNamespace(open=Mock(return_value="container"), AudioResampler=Mock(return_value="resampler"),
                                      error=SimpleNamespace(), AudioFrame=object())
        self.boundary = PROBE.AudioBoundary(self.native)

    def test_only_local_bytes_input_reaches_native_guard(self):
        source = io.BytesIO(b"fixture")
        self.assertEqual(self.boundary.open(source), "container")
        self.native.open.assert_called_once_with(source)
        self.assertEqual(self.boundary.calls, [{"operation": "av.open", "mode": "r", "input": "BytesIO"}])

    def test_output_protocol_and_options_fail_before_native_call(self):
        for source, args, kwargs in (("rtmp://host", (), {}), (io.BytesIO(), (), {"mode": "w"}),
                                     (io.BytesIO(), ("w",), {}), (io.BytesIO(), (), {"options": {"filter": "azmq"}})):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.boundary.open(source, *args, **kwargs)
        self.native.open.assert_not_called()

    def test_fixed_resampling_is_allowed_without_arbitrary_options(self):
        kwargs = {"format": "fltp", "layout": "mono", "rate": 16000}
        self.assertEqual(self.boundary.AudioResampler(**kwargs), "resampler")
        self.native.AudioResampler.assert_called_once_with(**kwargs)
        self.native.AudioResampler.reset_mock()
        for extra in ({"options": {"filter": "dynaudnorm"}}, {"rate": 48000}, {"layout": "stereo"}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.boundary.AudioResampler(**{**kwargs, **extra})
        self.native.AudioResampler.assert_not_called()

    def test_unknown_filter_command_and_encoder_interfaces_fail_closed(self):
        for attribute in ("filter", "Graph", "process_command", "CodecContext", "VideoFrame"):
            with self.subTest(attribute=attribute), self.assertRaisesRegex(ValueError, "Unexpected PyAV API"):
                getattr(self.boundary, attribute)


if __name__ == "__main__":
    unittest.main()
