"""Offline tests; native serving probes run only in the pinned hosted image."""
import ctypes
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


class MaskDenialTests(unittest.TestCase):
    def test_masks_require_existing_empty_readonly_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            masks = [Path(directory) / str(index) for index in range(3)]
            for path in masks:
                path.mkdir()
            with patch.object(PROBE, "REVIEWED_NATIVE_MASKS", tuple(map(str, masks))):
                with patch.object(PROBE.os, "access", return_value=False):
                    self.assertEqual(PROBE.verify_native_masks(), list(map(str, masks)))
                    (masks[0] / "injected.so").write_bytes(b"code")
                    with self.assertRaisesRegex(ValueError, "not masked"):
                        PROBE.verify_native_masks()
                    (masks[0] / "injected.so").unlink()
                    masks[0].rmdir()
                    with self.assertRaisesRegex(ValueError, "not masked"):
                        PROBE.verify_native_masks()
                    masks[0].mkdir()
                with patch.object(PROBE.os, "access", return_value=True):
                    with self.assertRaisesRegex(ValueError, "read-only"):
                        PROBE.verify_native_masks()

    def exercise(self, *, loader=None, spec=None, importer=None, mappings=None):
        def absent(name):
            raise ModuleNotFoundError(name, name=name)
        with patch.object(PROBE, "verify_native_masks", return_value=list(PROBE.REVIEWED_NATIVE_MASKS)), \
             patch.object(PROBE, "loaded_ffmpeg_libraries", side_effect=mappings or [["reviewed"], ["reviewed"]]), \
             patch("importlib.util.find_spec", return_value=spec), \
             patch.object(PROBE.importlib, "import_module", side_effect=importer or absent), \
             patch.object(ctypes, "CDLL", side_effect=loader or OSError("masked file absent")) as cdll:
            result = PROBE.verify_masked_native_denial("/opt/videoq-audio")
            self.assertEqual(cdll.call_args_list, [unittest.mock.call(path) for path in PROBE.REVIEWED_MASKED_FFMPEG_PATHS])
            return result

    def test_exact26_constant_absolute_loads_denied_and_missing_imports(self):
        self.assertEqual(len(PROBE.REVIEWED_MASKED_FFMPEG_PATHS), 26)
        self.assertEqual(len(set(PROBE.REVIEWED_MASKED_FFMPEG_PATHS)), 26)
        result = self.exercise()
        self.assertEqual(result["absoluteLoadsDenied"], list(PROBE.REVIEWED_MASKED_FFMPEG_PATHS))
        self.assertFalse(result["nativeFilterTraceComplete"])
        self.assertTrue(all(row["result"] == "not_found" for row in result["imports"]))

    def test_load_success_and_changed_mappings_fail(self):
        with self.assertRaisesRegex(ValueError, "library loaded"):
            self.exercise(loader=lambda path: object())
        with self.assertRaisesRegex(ValueError, "mappings changed"):
            self.exercise(mappings=[["reviewed"], ["alternate"]])
        with self.assertRaisesRegex(ValueError, "Unreviewed loaded"):
            self.exercise(mappings=ValueError("Unreviewed loaded FFmpeg library"))

    def test_executable_or_alternate_module_spec_never_imported(self):
        for spec in [SimpleNamespace(loader=None, origin="/unmasked/module.py", submodule_search_locations=[]),
                     SimpleNamespace(loader=None, origin=None, submodule_search_locations=["/unmasked"]),
                     SimpleNamespace(loader=None, origin=None, submodule_search_locations=[PROBE.REVIEWED_NATIVE_MASKS[0], "/alternate"])]:
            with self.subTest(spec=spec), self.assertRaisesRegex(ValueError, "Executable or alternate"):
                self.exercise(spec=spec)
        with self.assertRaisesRegex(ValueError, "executable module imported"):
            self.exercise(importer=lambda name: SimpleNamespace(__file__="/unmasked/module.so"))

    def test_non_namespace_loader_with_no_origin_is_rejected(self):
        spec = SimpleNamespace(loader=object(), origin=None,
                               submodule_search_locations=[PROBE.REVIEWED_NATIVE_MASKS[0]])
        with self.assertRaisesRegex(ValueError, "Executable or alternate"):
            self.exercise(spec=spec)

    def test_namespace_only_imports_must_have_exact_mask_path(self):
        specs = {"PyNvVideoCodec": PROBE.REVIEWED_NATIVE_MASKS[0],
                 "mooncake": PROBE.REVIEWED_NATIVE_MASKS[2]}
        def find(name):
            if name in specs:
                return SimpleNamespace(loader=None, origin=None, submodule_search_locations=[specs[name]])
            return None
        def load(name):
            if name in specs:
                return SimpleNamespace(__file__=None, __path__=[specs[name]])
            raise ModuleNotFoundError(name, name=name)
        with patch.object(PROBE, "verify_native_masks"), \
             patch.object(PROBE, "loaded_ffmpeg_libraries", return_value=["reviewed"]), \
             patch("importlib.util.find_spec", side_effect=find), \
             patch.object(PROBE.importlib, "import_module", side_effect=load), \
             patch.object(ctypes, "CDLL", side_effect=OSError("absent")):
            result = PROBE.verify_masked_native_denial("/opt/videoq-audio")
            self.assertEqual([r["result"] for r in result["imports"]],
                             ["empty_namespace_only", "not_found", "empty_namespace_only"])


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
