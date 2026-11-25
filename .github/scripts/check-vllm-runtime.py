"""Inspect the unchanged upstream image without a GPU or downloaded weights.

Always emit a machine-readable result, including when optional imports fail.
"""
import contextlib
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys



# Reviewed upstream vLLM tag 0.33.0, commit
# 4ba787ec9959e566d3b587a796dff07673324da5. Fail closed on image/source drift.
REVIEWED_VLLM_SOURCES = {'vllm/entrypoints/speech_to_text/base/serving.py': 'ea060ce1e3612ea056e1d6a3ef7bbd6291632290f10d48760520e9df22eb9299',
 'vllm/entrypoints/speech_to_text/base/utils.py': 'ab18a6bdf91d92bd87b86f9df90c8b81ed660b831416db41f3d8c2e80e2096e9',
 'vllm/entrypoints/speech_to_text/transcription/api_router.py': 'a9da965953b4dc1e4e9f40b27c89b2683db0f300a748fbabf84bb278dfe6ec0f',
 'vllm/entrypoints/speech_to_text/transcription/protocol.py': '354579ac9a05b28760f3c5401c367994bf9e84daf9ca833aa383f178efdcbe70',
 'vllm/multimodal/audio.py': '5a3f5c492e5ec6f9c213d0c2898b83573e39179a8cb8b6c9b920347e55ebf476',
 'vllm/multimodal/media/audio.py': 'cd88790d50e7feac9b94b89721cbf58e16dcf569020e4b08fa91da0efd6474e6'}
# Official av19.0.2 cp312-abi3 manylinux_2_28_x86_64 wheel SHA256
# 9c1da7aad0fa6c13b4a5c1e7985be0d13f8526a96284573acaf3d55ead6d3fe8.
# Includes compiled extensions: matching accompanying .py alone is insufficient.
REVIEWED_PYAV_MEMBERS = {'av.libs/libSvtAv1Enc-cc8e453e.so.4.2.0': 'bfd8be97db5aa29114f16ca0c2ce5e931215440156fceeb8e9270ed99b02acb8',
 'av.libs/libXau-154567c4.so.6.0.0': '8b5a93469805d3550471766696d4755f05bc6ca0587f22c03037ca7d12545c8b',
 'av.libs/libasound-c7818c60.so.2.0.0': 'd95d53060da5758d271dc16d8686950a3754739aecbeaa47e41d831b851ec056',
 'av.libs/libavcodec-d61378e8.so.63.1.102': '5ff458a6833094996f24c1928afe67dac1ec87cdb7c9e58d13a44703994bc3ed',
 'av.libs/libavdevice-c9c4901c.so.63.1.102': 'e6893ffa2f7a3bc36b14864f15b2c5ee946808d04b01a47af0ec9b077becf87e',
 'av.libs/libavfilter-6a4661f8.so.12.1.102': 'b75b07f97f56824cfc2803d34991f03f5aba859c67a7a8f86c7437914658f8e1',
 'av.libs/libavformat-7f5186bf.so.63.1.102': '4a54860701b836b3dd701f07dd48068af3e2891e68e00c4a0779b73af4ad9bf4',
 'av.libs/libavutil-8f0ab4ee.so.61.1.102': '61bb48e8fa35650e5b7f710500feeb39a4243cf1937d2774a3db0c5f9aef908d',
 'av.libs/libdav1d-0fe430b9.so.7.0.0': '819965f42b8ab0c0bead2f0d7689bfe68b89758d78d70239e97ac05dd998fb18',
 'av.libs/libdrm-b0291a67.so.2.4.0': 'e6315a0e5efd1918cd918755b09c188cb74c89e5882e966cd3111dc9015a6b1e',
 'av.libs/libgmp-8c6c054f.so.10.5.0': '9bef5e914c9932edd5890bbbff5fedc348a14d184cfea96f20b6e7c4e1b96a1c',
 'av.libs/libgnutls-e2125fb5.so.30.42.0': 'f594c721830c189c27aa8866c021f76872a3afb2444cef89998ebc3c78385b6f',
 'av.libs/libhogweed-e2118ea2.so.7.0': '28a6c71f005dbbae53f722a9ce113c480165a5ea7f1d7224fd01a0d34c20aa07',
 'av.libs/libnettle-6eb03162.so.9.0': 'c6fcd40f3302da8bd6983caa33d73166206100a632c9322d0d076bfbdf60353d',
 'av.libs/libopus-114e2b1a.so.0.11.1': '6b52801726dae225720c84ce12eaa7831af05dcea7be46f61b10d4a9fc653ce1',
 'av.libs/libsharpyuv-48a062bd.so.0.1.2': 'ecd8dd0fb4aed6144752f0a8aed49d463fdd01562dfd4bade29858457412cc0a',
 'av.libs/libswresample-d0a74e06.so.7.1.102': 'fcc73f5c140afb861890cc110dbc2237ab27a5b95a18e7d10937b965afcfad3f',
 'av.libs/libswscale-cd7831fd.so.10.1.102': 'a91d27bdb4b169cb30f688e2df9f8d13ee27814aacf4040e1b666e5f30fbbc65',
 'av.libs/libunistring-09f6121d.so.5.2.1': '4ee9e7d5ad934d77e1cc3f8e97ebb4f00b73bceb819481e8de516902c1ef46f2',
 'av.libs/libvmaf-258f7447.so.3.2.0': '1abf718ba21e1864b5726d35b823e66ddada368b23a4903b1c1277ae4afdf5a3',
 'av.libs/libvpl-e4e9cae8.so.2.16': 'e785c031664bc2371406743993e512f43768789706eea631f0f579c8a663bf0c',
 'av.libs/libvpx-e67815b1.so.12.1.0': '3f00682bbcf52605df96e34c43558f51713b514eaa9e684449063ab4afdaa81b',
 'av.libs/libwebp-0c5118d0.so.7.2.0': '759cd01a1be4510788207f7c27bd571378732689ee65a90090771a63bd45a274',
 'av.libs/libwebpmux-e1880640.so.3.1.2': '8bb9b22c7fd4bcd4aef03d2ce6fe26e7300c62f1a6b6f2a04d5f0abe63bf71ef',
 'av.libs/libx264-d6533a8d.so.165': 'd160fece833d838690a21850fb11aa0cc2b63e5b6b99d5f5f7e4dfc7a969a874',
 'av.libs/libx265-eebb7db1.so.217': 'a8251bd1c08f242a10ed8a103d01da3cabf990bf356c193cc655faa1eab4c422',
 'av.libs/libxcb-5ddf6756.so.1.1.0': 'b14c60bdd8c7a478268cf2a213357f60df597bcb32c014994ba47db55aa6ada7',
 'av.libs/libxcb-shape-7716c890.so.0.0.0': '1621690343035c7be475b4afe8d1d55431d8cf83ca0408d6ba70863f21bc74cf',
 'av.libs/libxcb-shm-0be6dfbf.so.0.0.0': '81d9e2e637d8cd790c82cde62643aa2ff163528eb0c1391608b59d0cc69a87c8',
 'av.libs/libxcb-xfixes-6de855b8.so.0.0.0': '8e9fb5ee12e6be883d94e074a5fdd5b41428082e6ca34678577ab89ca08ae950',
 'av/_core.abi3.so': '9c130a19bf4b540dff4878f96853cdf5f73fd5d8abcb8c2bab260407ce592291',
 'av/_cyutil.abi3.so': 'bd5a0bea6766eb91a9166833e29e166bf59374323a6dfd548e1ed70f4a6722c0',
 'av/audio/codeccontext.abi3.so': '897dce17ea493931cc6a96dfe5d32b06116ddc813c255782595c9c92f6833cf5',
 'av/audio/fifo.abi3.so': '75825109a41b9ccb077b2d81cf61ed5c6c14a7ea1959bb78b2886572ea35e519',
 'av/audio/format.abi3.so': '2390eb58a5268db0c22acdbe2f156974982a1743307a88a8b48fdcf682af7f81',
 'av/audio/frame.abi3.so': 'bcf2be27ecb5c6caaa590c0e5360b836737882b9ab8ebc2ed4b2258641d605d7',
 'av/audio/layout.abi3.so': '91b47517767dfb13abe5e56a2e6fe1d0d532623a9829af383dcd77824292c2e1',
 'av/audio/plane.abi3.so': '403711bd9cd6654838e84715b7e74c9c6b7ab19fb8ad9e29d63da327dcf5c952',
 'av/audio/resampler.abi3.so': '9d475d1c336f1488527fdd1e1c44ea526b630df4c0ca4b9c7b2deaaa84259885',
 'av/audio/resampler.py': '68299f15405bdc4d29d29ac2a13ee403ed6cf1a3340897c7b4f5d4b51526bfc3',
 'av/audio/stream.abi3.so': 'a639f6b166b477f9882325ffcbecd98582236cf3c2ace789d55b174833827129',
 'av/bitstream.abi3.so': '4479d668a0d00455e1f26e77c36c19e0d90be0594239b3be43c5fc5237ac6410',
 'av/buffer.abi3.so': '108a99efba941a0d03f2ea075ea6ebfe6aa9bd8ee9821d275b0796db39d8ba07',
 'av/codec/codec.abi3.so': 'f042280ee3f918292af8de0c447bc3e3ad19d3268d57c9c10e809a35079733fc',
 'av/codec/context.abi3.so': '9ad7b0d4c869e5b937e09eaca48b4d5e6a9dd92f6115ab042412b6904d0ece53',
 'av/codec/hwaccel.abi3.so': '310b7d512b97176e599fd7f689710a1f09045ef265d845ffd849e551651f5870',
 'av/container/core.abi3.so': '68878ceafb62e3f7645d21d516a5eff4d99f3d7b57663b8546efa942d2306ae9',
 'av/container/core.py': 'c59c72bf9d52fc1d743012f10d2757b33dc4fe39639c92f5021c0cd7ee85122c',
 'av/container/input.abi3.so': '57debf985dc51dc692a5a83eca1b4398d6a1c98a3b9a30fd1025e4d31c8addfd',
 'av/container/output.abi3.so': '2f41dc86f3bad1546f98e9d548e5efb2acc94547737583e697330cca890d9ab5',
 'av/container/pyio.abi3.so': '9d2670f6b22b59f3cd02d747a8d92e2fdf4badf8640e22c083cdfa3f6fa2846e',
 'av/container/streams.abi3.so': '9d343c5d3e49bfef201a521c99153e6736685433c20d85bfea0cffc25f4baf3c',
 'av/device.abi3.so': 'c561c95a8565dfc4d67e63be20f3e4e1af484bb973f3ea93d1e5d1d4dfc8f7da',
 'av/dictionary.abi3.so': 'ccbed216212aadf7a022bdc535385a247f692bdd95e4ad13af74a6b3a1c507b8',
 'av/error.abi3.so': '6a1c45f869e608b9169bf775c70aa46d4dd6ca0927d4570047eff1e0cd0bca76',
 'av/filter/context.abi3.so': '6047415dfa0d78b1a27b3ddd7b2631e2d8c65d9a0992a5931bce4840687c3ebf',
 'av/filter/context.py': 'dd971bf8f91a3e41b805f181e3d6359eff294ad5a1b6971fc30b1eaddef83eae',
 'av/filter/filter.abi3.so': '268c521e8a0bc852226031a6c8cb000ca88dda2aad8d12d26c479f1da2768db7',
 'av/filter/graph.abi3.so': '5bc0998e389eec0e8a87d49d687108bb3f8e6c56b5dcaae5f99acf3f47cae46f',
 'av/filter/graph.py': '02bbf1475d433af3d64782f45db2f802fc12f47f377465eb111425ceddabe770',
 'av/filter/link.abi3.so': '77b0cc9bc991ffc56064f4ed1803bc8098da4523e065955993c99bc13ad087c7',
 'av/filter/loudnorm.abi3.so': '7ea0f7753561e6593203128d02dadc24583eabbab2b29c3bafaf4b20fe9e4134',
 'av/format.abi3.so': '6a6e1b6ef918881f135670bc3fb6c7f2ed262dfba5ce247315704b3402f77019',
 'av/frame.abi3.so': '5b787bf7925f8eb26ff658fb6120f3742d79a2f8c51f4bf358e8b80d4f4a9a36',
 'av/index.abi3.so': 'b48778328baff9076274e44690d743c7d85e22caacd749567cff0ce1da97d20a',
 'av/logging.abi3.so': 'eb5ff3d355ce5358b00df2a1b8fb1a1f66273e924842b0cb0088e49c7d1bc384',
 'av/opaque.abi3.so': '77d2b0c73c884273c31aa270437953d9437e6dd33ef5464d18844686030717ab',
 'av/packet.abi3.so': '90abf837126be79e5018e868b9efda5306dea596ce816f834d0c193ba6dbc28f',
 'av/plane.abi3.so': '4d3313940ca8132311cc12a713e8cc86ae58fbba833a90aea4e9dc1bf3025c91',
 'av/rational.abi3.so': '05b5a7c8780e184015956acd13297b6e8706bd37f0774dd1c790548d5549fd40',
 'av/sidedata/encparams.abi3.so': '82123845759b83b422f279de3de03668696b6c908df7edf3f893bfaee5fec5f6',
 'av/sidedata/motionvectors.abi3.so': '35afec34b8385ca52bbebdc3c16529e7a16195ac022378fb5156fbde54f42a56',
 'av/sidedata/sidedata.abi3.so': '781b44c17c42208a80db1843637c76101aaf2863417d5c011ebd1e534b9060e2',
 'av/stream.abi3.so': '8cc441986d609aeb21dcd7b3ba5d1d98cc43ba3880f93a737a587c0467de7a24',
 'av/subtitles/codeccontext.abi3.so': 'b1f69241dede1f4fe80229a80d0c7e64f3bb629dd0ae8575bca8e3ddf6c0f85c',
 'av/subtitles/stream.abi3.so': 'df03bcb2bba088c4c26f0c5805f0f6b1558fe1975889e9fc9946b7e569e0cf0d',
 'av/subtitles/subtitle.abi3.so': 'fc9dfb0695e59e4e8f04328a2a286ddc6b5f9f0fc495dfc96f0753f765de43be',
 'av/utils.abi3.so': 'aef3c6937b7141a44628f2f223de7ddd55dd9561081e3d02b43588ff885d2821',
 'av/video/codeccontext.abi3.so': 'efdd4110b9d21dfb87071317ff759d0f8fdecec0e2a0c2c752a71d2a993f97d6',
 'av/video/format.abi3.so': 'a8f447298f413553c8c222710b6091466511e6202a2d4677bb8d717739d659d0',
 'av/video/frame.abi3.so': '35a81102b2db4f8577ee18432e016f3af14361650ab05014fe793192525b25bd',
 'av/video/plane.abi3.so': '4505456d9af9d74462ba1064d6654d0fb89adaad6c4d75fb91f74c775708c5e3',
 'av/video/reformatter.abi3.so': 'cfb097ced1cbd47647c8bd01799c6396e8f9386ec5f372c1276aa68689291ecb',
 'av/video/stream.abi3.so': '79c87ef15b38d8c114c01fcd15c7b74d581f70dc48a2531683ae20d3d6110bca'}


def verify_reviewed_files(root, expected):
    """Never substitute version labels for the installed files' identities."""
    root = Path(root).resolve()
    observed = {}
    for relative, digest in expected.items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Reviewed source escaped its package root")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != digest:
            raise ValueError(f"Unreviewed installed source/native member: {relative}")
        observed[relative] = actual
    return observed


class AudioBoundary:
    """Observe Python->native calls, without pretending to trace Cython cimports.

    Used only around the probe's calls, never installed into the serving image.
    Unknown attributes fail closed. The native AudioResampler's internal graph
    remains separately identified by immutable wheel hashes, not monkeypatches.
    """
    def __init__(self, native):
        self.native = native
        self.calls = []
        self.error = native.error
        self.AudioFrame = native.AudioFrame

    def open(self, file, *args, **kwargs):
        from io import BytesIO
        if args or not isinstance(file, BytesIO) or kwargs:
            raise ValueError("Unexpected native input/output/options boundary")
        self.calls.append({"operation": "av.open", "mode": "r", "input": "BytesIO"})
        return self.native.open(file)

    def AudioResampler(self, *args, **kwargs):
        if args or kwargs != {"format": "fltp", "layout": "mono", "rate": 16000}:
            raise ValueError("Unexpected native resampler/filter options")
        self.calls.append({"operation": "AudioResampler", **kwargs})
        return self.native.AudioResampler(**kwargs)

    def __getattr__(self, name):
        raise ValueError(f"Unexpected PyAV API at serving boundary: {name}")


def loaded_ffmpeg_libraries(audio_root, maps_path="/proc/self/maps"):
    """Detect an alternate loaded FFmpeg copy in the offline Linux native job."""
    root = Path(audio_root).absolute()
    approved = root / "av.libs"
    paths = set()
    for line in Path(maps_path).read_text().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) < 6 or not fields[5].startswith("/"):
            continue
        path = Path(fields[5])
        if path.name.startswith(("libavcodec", "libavformat", "libavfilter", "libavutil",
                                 "libavdevice", "libswresample", "libswscale")):
            try:
                resolved = path.resolve(strict=True)
                relative = resolved.relative_to(root).as_posix()
                # A maps entry must name the exact existing reviewed member,
                # not a deleted mapping, symlink alias or same-directory copy.
                if (str(resolved) != fields[5] or not resolved.is_relative_to(approved)
                        or not resolved.is_file() or relative not in REVIEWED_PYAV_MEMBERS
                        or any(part.is_symlink() for part in (path, *path.parents))):
                    raise ValueError("Mapped path is not an exact regular reviewed member")
                if hashlib.sha256(resolved.read_bytes()).hexdigest() != REVIEWED_PYAV_MEMBERS[relative]:
                    raise ValueError("Mapped member hash drift")
            except (OSError, ValueError) as error:
                raise ValueError(f"Unreviewed loaded FFmpeg library: {path}") from error
            paths.add(str(resolved))
    if not paths:
        raise ValueError("No actual FFmpeg library mapping observed")
    return sorted(paths)


def inspect_serving_audio_boundary(audio_root):
    import io
    from types import SimpleNamespace
    from unittest.mock import patch
    import av
    import numpy as np
    import soundfile
    import sitecustomize
    import vllm

    if getattr(av.open, "__videoq_audio_guard__", None) != "local-audio-only-v2":
        raise ValueError("Refusing native probes without the installed local-input guard")
    guard = audio_root / "sitecustomize.py"
    if (Path(sitecustomize.__file__).resolve() != guard or
            hashlib.sha256(guard.read_bytes()).hexdigest() !=
            "ea09f7753f1ad771f9d7acc6b1a33289e20b6f59e83ac367e03513ffb3a2bb5a"):
        raise ValueError("Unreviewed installed audio adapter")
    package_root = Path(vllm.__file__).resolve().parent.parent
    sources = verify_reviewed_files(package_root, REVIEWED_VLLM_SOURCES)
    members = verify_reviewed_files(audio_root, REVIEWED_PYAV_MEMBERS)
    import vllm.multimodal.audio as audio_utils
    import vllm.multimodal.media.audio as loader
    from vllm.entrypoints.speech_to_text.base.serving import SpeechToTextBaseServing
    boundary = AudioBoundary(av)
    # No engine/model/weights. Execute the actual installed unbound serving
    # method, with its real decoder and duration implementation.
    server = SimpleNamespace(
        asr_config=SimpleNamespace(sample_rate=16000, allow_audio_chunking=False),
        max_audio_decode_duration_s=1, max_audio_decode_bytes=1024 * 1024,
    )
    cases = []
    with patch.object(loader, "av", boundary), patch.object(audio_utils, "av", boundary):
        # Cover explicit PyAV fallback and the actual auto-selected serving path.
        for fmt in ("WAV", "FLAC"):
            for rate, channels in ((16000, 1), (48000, 2)):
                buf = io.BytesIO()
                soundfile.write(buf, np.zeros((rate // 10, channels), dtype=np.float32),
                                rate, format=fmt, subtype="PCM_16")
                raw = buf.getvalue()
                waveform, decoded_rate = loader.load_audio_pyav(io.BytesIO(raw), sr=16000)
                if decoded_rate != 16000 or waveform.size != 1600:
                    raise ValueError("Actual PyAV decode/resample shape mismatch")
                chunks, duration = SpeechToTextBaseServing._decode_and_chunk_speech(server, raw)
                if len(chunks) != 1 or chunks[0].size != 1600 or abs(duration - .1) > .001:
                    raise ValueError("Actual serving preprocessing shape mismatch")
                cases.append({"format": fmt, "rate": rate, "channels": channels})
        for backend in ("azmq", "dynaudnorm", "rtmp"):
            try:
                loader.AudioMediaIO(audio_backend=backend)
            except ValueError:
                pass
            else:
                raise ValueError("Unrecognized media backend accepted")
        # Inputs/options cannot provide a native graph expression on this API.
        media = loader.AudioMediaIO(audio_backend="pyav", filter="dynaudnorm",
                                   options={"filter": "azmq"}, mode="w")
        media.load_bytes(raw)
        for malicious in (b"", b"<CompositionPlaylist><MarkerList/></CompositionPlaylist>",
                          b"rtmp://127.0.0.1/rejected", rb"azmq=bind_address=tcp\://*:5555"):
            try:
                SpeechToTextBaseServing._decode_and_chunk_speech(server, malicious)
            except (ValueError, av.error.FFmpegError):
                pass
            else:
                raise ValueError("Malformed/non-audio serving input accepted")
    if not any(c["operation"] == "AudioResampler" for c in boundary.calls):
        raise ValueError("Native resampling was not exercised")
    # Independently exercise production guard denials, never contact a network.
    rejected = []
    for label, file, kwargs in (
        ("output", io.BytesIO(), {"mode": "w"}),
        ("rtmp", "rtmp://127.0.0.1/rejected", {}),
        ("http", "http://127.0.0.1/rejected", {}),
        ("imf", io.BytesIO(b"not-imf"), {"format": "imf"}),
        ("customIO", io.BytesIO(), {"io_open": lambda *a: None}),
    ):
        try:
            av.open(file, **kwargs)
        except ValueError:
            rejected.append(label)
        else:
            raise ValueError(f"Forbidden native boundary accepted: {label}")
    libraries = loaded_ffmpeg_libraries(audio_root)
    return {
        "loadedFfmpegLibraries": libraries,
        "guardSha256": hashlib.sha256(guard.read_bytes()).hexdigest(),
        "vllmSources": sources, "pyavWheelMembers": members,
        "validCases": cases, "calls": boundary.calls, "guardDenials": rejected,
        "scope": "Actual installed speech preprocessing and explicit PyAV decode; no model execution",
        "nativeFilterTraceComplete": False,
        "remainingGap": "Cython AudioResampler privately cimports Graph; Python facade does not trace internal filter nodes. Exact wheel members are pinned, but complete native filter/command reachability requires instrumented/rebuilt FFmpeg or equivalent native tracing. Multimodal model-specific loaders and alternative torchcodec backend require separate coverage.",
    }


def inspect_patched_dns(audio_root):
    import dns
    import dns.exception
    import dns.rdata
    path = Path(dns.__file__).resolve()
    if importlib.metadata.version("dnspython") != "2.9.2" or path != audio_root / "dns/__init__.py":
        raise ValueError("The pinned patched DNS package must resolve from the read-only runtime volume")
    # Bounded upstream reproducer; do not request a DoS-sized allocation.
    try:
        dns.rdata.from_text("IN", "WKS", "10.0.0.1 udp 65536")
    except dns.exception.SyntaxError:
        return {"version": "2.9.2", "modulePath": str(path), "oversizedWksRejected": True}
    raise ValueError("Patched DNS parser did not reject an out-of-range service")


def inspect_runtime():
    checks = {}

    def check(name, operation):
        try:
            # vLLM initialization may log to stdout; keep the artifact valid JSON.
            with contextlib.redirect_stdout(sys.stderr):
                details = operation()
            checks[name] = {"status": "passed", "details": details}
        except Exception as error:
            checks[name] = {"status": "failed", "errorType": type(error).__name__, "error": str(error)}

    def version():
        value = importlib.metadata.version("vllm")
        if value != "0.33.0":
            raise ValueError(f"Expected pinned vLLM 0.33.0, found {value}")
        return value

    check("version", version)
    audio_root = Path("/opt/videoq-audio").resolve()
    def audio_lock():
        receipt = json.loads((audio_root / ".videoq-audio.json").read_text())
        for name, expected in receipt["manifest"]["basePackages"].items():
            actual = importlib.metadata.version(name)
            if actual != expected:
                raise ValueError(f"Base dependency changed: {name} {actual}, expected {expected}")
        for package in receipt["manifest"]["packages"]:
            if importlib.metadata.version(package["name"]) != package["version"]:
                raise ValueError(f"Audio dependency changed: {package['name']}")
        return receipt["lockSha256"]

    check("audioLock", audio_lock)
    check("security.dnspython", lambda: inspect_patched_dns(audio_root))
    for module in ("av", "soxr", "soundfile", "scipy"):
        def audio_import(module=module):
            loaded = importlib.import_module(module)
            path = Path(loaded.__file__).resolve()
            if not path.is_relative_to(audio_root):
                raise ValueError(f"{module} was imported outside the reviewed audio volume")
            return str(path)
        check(f"audio.{module}", audio_import)

    def decode_audio():
        from io import BytesIO
        import av
        import numpy as np
        import scipy.signal
        import soundfile
        import soxr
        samples = np.zeros(1600, dtype=np.float32)
        stream = BytesIO()
        soundfile.write(stream, samples, 16000, format="WAV")
        stream.seek(0)
        decoded, rate = soundfile.read(stream)
        if rate != 16000 or len(decoded) != len(samples):
            raise ValueError("SoundFile WAV round trip failed")
        stream.seek(0)
        with av.open(stream) as container:
            if sum(frame.samples for frame in container.decode(audio=0)) != len(samples):
                raise ValueError("PyAV could not decode WAV samples")
        if len(soxr.resample(samples, 16000, 8000)) != 800 or len(scipy.signal.resample_poly(samples, 1, 2)) != 800:
            raise ValueError("Audio resampling failed")
        return {"decodedSamples": len(decoded), "rate": rate}

    check("audioDecodeAndResample", decode_audio)
    check("security.servingAudioBoundary", lambda: inspect_serving_audio_boundary(audio_root))

    def audio_security():
        import av
        import sitecustomize
        guard = audio_root / 'sitecustomize.py'
        receipt = json.loads((audio_root / '.videoq-audio.json').read_text())
        if Path(sitecustomize.__file__).resolve() != guard or hashlib.sha256(guard.read_bytes()).hexdigest() != receipt['manifest']['runtimeGuardSha256']:
            raise ValueError('Audio startup guard identity changed')
        if getattr(av.open, '__videoq_audio_guard__', None) != 'local-audio-only-v2':
            raise ValueError('PyAV must enforce the reviewed local-audio guard')
        try:
            av.open('rtsp://127.0.0.1/rejected')
        except ValueError as error:
            if 'network URLs' not in str(error):
                raise
        else:
            raise ValueError('RTSP input was not rejected before network I/O')
        # A-law is a valid WAV codec, but is outside the supported input contract.
        import io
        import struct
        data = b'\xd5' * 160
        wav = b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVEfmt ' + struct.pack('<IHHIIHH',16,6,1,16000,16000,1,8) + b'data' + struct.pack('<I',len(data)) + data
        try:
            with av.open(io.BytesIO(wav), format='wav') as container:
                list(container.decode(audio=0))
        except (ValueError, av.error.FFmpegError):
            pass
        else:
            raise ValueError('Unsupported WAV codec was not rejected')
        return {'guardSha256': receipt['manifest']['runtimeGuardSha256'], 'rtspRejected': True,
                'unsupportedWavCodecRejected': True, 'allowedCodecs': ['flac','mp3','mp3float','pcm_s16le']}

    check('security.audio', audio_security)

    def native_masks():
        paths = ['/usr/local/lib/python3.12/dist-packages/PyNvVideoCodec', '/usr/local/lib/python3.12/dist-packages/opencv_python_headless.libs', '/usr/local/lib/python3.12/dist-packages/mooncake']
        for path in paths:
            if not Path(path).is_dir() or list(Path(path).iterdir()):
                raise ValueError(f'Unused native library directory is not masked: {path}')
            if os.access(path, os.W_OK):
                raise ValueError(f'Native mask must be read-only: {path}')
        return paths

    check('security.maskedNative', native_masks)

    def registry():
        from vllm.model_executor.models import ModelRegistry
        architectures = ("GptOssForCausalLM", "Gemma4ForConditionalGeneration", "EmbeddingGemma2Model", "WhisperForConditionalGeneration")
        for architecture in architectures:
            if architecture not in ModelRegistry.get_supported_archs():
                raise ValueError(f"Missing architecture: {architecture}")
        return list(architectures)

    check("modelRegistry", registry)

    def embeddings():
        from vllm.entrypoints.pooling.embed.protocol import EmbeddingCompletionRequest
        request = EmbeddingCompletionRequest(model="probe", input="task: search result | query: probe", dimensions=768)
        if request.to_pooling_params().dimensions != 768:
            raise ValueError("Embedding API did not preserve 768 dimensions")
        return {"dimensions": 768}

    check("embeddingProtocol", embeddings)
    return {"status": "passed" if all(c["status"] == "passed" for c in checks.values()) else "failed", "checks": checks}


if __name__ == "__main__":
    result = inspect_runtime()
    print(json.dumps(result))
    sys.exit(0 if result["status"] == "passed" else 1)
