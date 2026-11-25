"""Offline tests; native serving probes run only in the pinned hosted image."""
import ctypes
from contextlib import contextmanager
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
            masks = [Path(directory) / str(index) for index in range(4)]
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
             patch.object(PROBE, "verify_torchcodec_mask", return_value={"root": "empty_namespace_only"}), \
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
             patch.object(PROBE, "verify_torchcodec_mask", return_value={"root": "empty_namespace_only"}), \
             patch.object(PROBE, "loaded_ffmpeg_libraries", return_value=["reviewed"]), \
             patch("importlib.util.find_spec", side_effect=find), \
             patch.object(PROBE.importlib, "import_module", side_effect=load), \
             patch.object(ctypes, "CDLL", side_effect=OSError("absent")):
            result = PROBE.verify_masked_native_denial("/opt/videoq-audio")
            self.assertEqual([r["result"] for r in result["imports"]],
                             ["empty_namespace_only", "not_found", "empty_namespace_only"])


class PyavReleaseTests(unittest.TestCase):
    def fixture(self):
        native = SimpleNamespace(__version__="19.0.2", ffmpeg_version_info="9.1",
                                 library_versions=dict(PROBE.REVIEWED_FFMPEG_VERSIONS))
        package = {"name": "av", "version": "19.0.2", "ffmpegVersion": "9.1",
                   "filename": "av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl",
                   "url": PROBE.REVIEWED_PYAV_WHEEL_URL, "sha256": PROBE.REVIEWED_PYAV_WHEEL_SHA256,
                   "size": PROBE.REVIEWED_PYAV_WHEEL_SIZE}
        return native, {"manifest": {"packages": [package]}}

    def test_exact_published_release_and_all227_native_source_members(self):
        native, receipt = self.fixture()
        self.assertEqual(PROBE.verify_pyav_release(native, receipt)["ffmpegVersion"], "9.1")
        self.assertEqual(len(PROBE.REVIEWED_PYAV_MEMBERS), 227)
        libraries = {name for name in PROBE.REVIEWED_PYAV_MEMBERS if name.startswith("av.libs/")}
        self.assertEqual(len(libraries), 7)
        self.assertIn("av.libs/libavcodec-603659c5.so.63.24.100", libraries)
        self.assertNotIn("av.libs/libavcodec-d61378e8.so.63.1.102", libraries)

    def test_release_receipt_version_library_or_hash_drift_rejected(self):
        for key, value in [("url", "https://github.com/other/project/wheel.whl"),
                           ("sha256", "0" * 64), ("size", 1), ("version", "19.0.3"),
                           ("filename", "renamed.whl"), ("ffmpegVersion", "9.0.2")]:
            with self.subTest(key=key):
                native, receipt = self.fixture()
                receipt["manifest"]["packages"][0][key] = value
                with self.assertRaises(ValueError):
                    PROBE.verify_pyav_release(native, receipt)
        for mutate in [lambda native: setattr(native, "ffmpeg_version_info", "9.0.2"),
                       lambda native: setattr(native, "__version__", "19.0.1"),
                       lambda native: native.library_versions.update(libavcodec=(63, 1, 102)),
                       lambda native: native.library_versions.update(libunknown=(1, 0, 0))]:
            native, receipt = self.fixture()
            mutate(native)
            with self.assertRaises(ValueError):
                PROBE.verify_pyav_release(native, receipt)
        native, receipt = self.fixture()
        receipt["manifest"]["packages"].append(dict(receipt["manifest"]["packages"][0]))
        with self.assertRaises(ValueError):
            PROBE.verify_pyav_release(native, receipt)


class TorchCodecMaskTests(unittest.TestCase):
    @contextmanager
    def masked_package(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(PROBE.sys.modules):
            for name in list(PROBE.sys.modules):
                if name == "torchcodec" or name.startswith("torchcodec."):
                    del PROBE.sys.modules[name]
            root = Path(directory).resolve()
            masks = [root / name for name in ("PyNvVideoCodec", "opencv.libs", "mooncake", "torchcodec")]
            for mask in masks:
                mask.mkdir()
            with patch.object(PROBE, "REVIEWED_NATIVE_MASKS", tuple(map(str, masks))), \
                 patch.object(PROBE.sys, "path", [str(root)]), \
                 patch.object(PROBE.os, "access", return_value=False):
                PROBE.importlib.invalidate_caches()
                yield masks

    def test_real_empty_namespace_denies_decoders_and_native_core(self):
        with self.masked_package() as masks:
            result = PROBE.verify_torchcodec_mask()
            self.assertEqual(result["path"], str(masks[3]))
            self.assertEqual(result["importsDenied"],
                             ["torchcodec.decoders", "torchcodec._core", "torchcodec._core.ops"])
            self.assertIsNone(PROBE.sys.modules["torchcodec"].__file__)
            # Re-observation of the genuine cached empty namespace remains valid.
            self.assertEqual(PROBE.verify_torchcodec_mask(), result)

    def test_preloaded_code_submodule_or_alternate_root_rejected(self):
        for variant in ("submodule", "code-root", "alternate-root", "custom-loader"):
            with self.subTest(variant=variant), self.masked_package() as masks:
                PROBE.verify_torchcodec_mask()
                module = PROBE.sys.modules["torchcodec"]
                if variant == "submodule":
                    PROBE.sys.modules["torchcodec._core"] = SimpleNamespace()
                elif variant == "code-root":
                    module.__file__ = str(masks[3] / "__init__.py")
                elif variant == "alternate-root":
                    module.__path__ = ["/unmasked/torchcodec"]
                else:
                    module.__loader__ = object()
                with self.assertRaises(ValueError):
                    PROBE.verify_torchcodec_mask()

    def test_executable_file_missing_or_writable_fourth_mask_rejected(self):
        for variant in ("code", "missing", "writable", "symlink"):
            with self.subTest(variant=variant), self.masked_package() as masks:
                if variant == "code":
                    (masks[3] / "__init__.py").write_text("raise AssertionError('must never execute')")
                elif variant == "missing":
                    masks[3].rmdir()
                elif variant == "symlink":
                    masks[3].rmdir()
                    masks[3].symlink_to(masks[0], target_is_directory=True)
                with patch.object(PROBE.os, "access", side_effect=lambda path, mode: variant == "writable" and path == masks[3]):
                    with self.assertRaises(ValueError):
                        PROBE.verify_torchcodec_mask()


class DecodeReferenceTests(unittest.TestCase):
    def test_exact_unflushed_prefix_and_full_reference_tail_are_recorded(self):
        import numpy as np
        complete = np.linspace(-0.2, 0.2, 1600, dtype=np.float32)
        for count in (1600, 1584):
            prefix = complete[:count]
            result = PROBE.verify_pyav_prefix(prefix.copy(), 16000, prefix, complete)
            self.assertEqual(result["bufferedTailSamples"], 1600 - count)
            self.assertEqual(result["fullReferenceSamples"], 1600)
        #1584 is synthetic, not a claim about an observed native receipt.

    def test_reference_collects_native_emitted_prefix_and_flushes_buffered_tail(self):
        import numpy as np
        complete = np.linspace(-0.2, 0.2, 1600, dtype=np.float32).reshape(1, -1)
        def frame(samples):
            return SimpleNamespace(to_ndarray=lambda: samples)
        resampler = Mock()
        resampler.resample.side_effect = [[frame(complete[:, :-16])], [frame(complete[:, -16:])]]
        container = SimpleNamespace(streams=SimpleNamespace(audio=[SimpleNamespace(rate=48000)]),
                                    decode=lambda stream: ["native frame"])
        context = Mock()
        context.__enter__ = Mock(return_value=container)
        context.__exit__ = Mock(return_value=False)
        native = SimpleNamespace(open=Mock(return_value=context), AudioResampler=Mock(return_value=resampler))
        prefix, full = PROBE.reference_pyav_decode(native, b"fixture")
        np.testing.assert_array_equal(prefix, complete[0, :-16])
        np.testing.assert_array_equal(full, complete[0])
        self.assertEqual(resampler.resample.call_args_list,
                         [unittest.mock.call("native frame"), unittest.mock.call(None)])
        native.AudioResampler.assert_called_once_with(format="fltp", layout="mono", rate=16000)

    def test_mapping_snapshot_is_diagnostic_and_does_not_approve_unknown_library(self):
        with tempfile.TemporaryDirectory() as directory:
            maps = Path(directory) / "maps"
            unknown = "/usr/lib/x86_64-linux-gnu/libswscale.so.7.5.100"
            maps.write_text(f"1000-2000 r-xp 0 00:00 0 {unknown}\n")
            self.assertEqual(PROBE.ffmpeg_mapping_snapshot(maps), [unknown])
            with self.assertRaisesRegex(ValueError, "Unreviewed loaded"):
                PROBE.loaded_ffmpeg_libraries(directory, maps)

    def test_auto_serving_preserves_normalization_full_samples_and_duration(self):
        import numpy as np
        reference = np.linspace(-0.2, 0.2, 1600, dtype=np.float32)
        PROBE.verify_auto_serving_waveform([reference.copy()], .1, reference)
        for chunks, duration in [([reference * 32768], .1), ([reference[:-16]], .1),
                                 ([reference.reshape(1, -1)], .1), ([reference * np.nan], .1),
                                 ([reference], float("nan")), ([reference], .09)]:
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                PROBE.verify_auto_serving_waveform(chunks, duration, reference)

    def test_rate_channels_nonfinite_corrupt_prefix_or_incomplete_reference_fail(self):
        import numpy as np
        complete = np.linspace(-0.2, 0.2, 1600, dtype=np.float32)
        for waveform, rate, prefix, full in [
            (complete, 48000, complete, complete),
            (complete.reshape(1, -1), 16000, complete, complete),
            (complete.astype(np.float64), 16000, complete, complete),
            (complete * np.nan, 16000, complete, complete),
            (complete + 0.1, 16000, complete, complete),
            (complete[:-1], 16000, complete, complete),
            (complete, 16000, complete, complete[:-1]),
            (complete, 16000, complete, complete[::-1]),
        ]:
            with self.subTest(rate=rate, shape=waveform.shape), self.assertRaises(ValueError):
                PROBE.verify_pyav_prefix(waveform, rate, prefix, full)


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
