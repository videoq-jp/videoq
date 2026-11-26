"""Offline candidate-native smoke. Never download weights or contact a model API."""
import argparse
import ctypes
import hashlib
import io
import json
from pathlib import Path
import sys
import wave

ROOT = Path(__file__).resolve().parent
CODECS = {'mp3', 'mp3float', 'pcm_s16le', 'flac'}
FILTERS = {'abuffer', 'abuffersink', 'buffer', 'buffersink', 'aformat', 'aresample'}
# Explicit reviewed production guard; changes require source/lock regression review.
REVIEWED_GUARD_SHA256 = 'bb52374777acff1a921c667bd116b3fbe4c010f5a01be13eeea0735c3fbce9a5'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_serving_guard(path):
    if sha(path) != REVIEWED_GUARD_SHA256:
        raise ValueError('Unreviewed serving audio adapter')


def verify_members(site_root, members):
    site_root = Path(site_root).resolve(strict=True)
    checked = {}
    for name, digest in members.items():
        if not (name.startswith('av/') or name.startswith('av.libs/')):
            continue
        path = (site_root / name).resolve(strict=True)
        if not path.is_relative_to(site_root) or not path.is_file() or sha(path) != digest:
            raise ValueError(f'Installed candidate member mismatch: {name}')
        checked[name] = digest
    if not any(name.startswith('av.libs/') for name in checked):
        raise ValueError('Wheel has no bundled native ELF closure')
    return checked


def protocols(library):
    library.avio_enum_protocols.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int]
    library.avio_enum_protocols.restype = ctypes.c_char_p
    result = {}
    for mode in (0, 1):
        opaque = ctypes.c_void_p()
        names = []
        while True:
            name = library.avio_enum_protocols(ctypes.byref(opaque), mode)
            if name is None:
                break
            names.append(name.decode())
        result[str(mode)] = sorted(names)
    if set(result['0']) != {'file', 'pipe'} or not set(result['1']) <= {'file', 'pipe'}:
        raise ValueError('Unexpected native network protocol')
    library.av_muxer_iterate.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
    library.av_muxer_iterate.restype = ctypes.c_void_p
    if library.av_muxer_iterate(ctypes.byref(ctypes.c_void_p())):
        raise ValueError('Unexpected compiled output muxer')
    return result


def loaded_closure(site_root, members):
    site_root = Path(site_root).resolve(strict=True)
    paths = set()
    for line in Path('/proc/self/maps').read_text().splitlines():
        fields = line.split(maxsplit=5)
        if len(fields) != 6 or not fields[5].startswith('/'):
            continue
        path = Path(fields[5])
        if path.name.startswith(('libav', 'libswresample', 'libswscale')):
            resolved = path.resolve(strict=True)
            if not resolved.is_relative_to(site_root):
                raise ValueError(f'Noncandidate loaded ELF: {path}')
            relative = str(resolved.relative_to(site_root))
            if relative not in members or not resolved.is_file() or sha(resolved) != members[relative]:
                raise ValueError(f'Unknown or changed loaded ELF: {path}')
            paths.add(str(resolved))
    if not paths:
        raise ValueError('No native FFmpeg mappings observed')
    return sorted(paths)


def wav_fixture(rate, channels):
    stream = io.BytesIO()
    with wave.open(stream, 'wb') as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(b'\0\0' * (rate // 10) * channels)
    return stream.getvalue()


def inspect(serving=False):
    import av
    data = json.loads((ROOT / 'provenance.json').read_text())
    source = json.loads((ROOT / 'source-lock.json').read_text())
    if sha(ROOT / 'source-lock.json') != data['sourceLockSha256']:
        raise ValueError('Candidate source lock/provenance mismatch')
    if sys.version_info[:2] != (3, 12) or av.__version__ != '19.0.2':
        raise ValueError('Candidate must preserve Python3.12/PyAV19.0.2 contract')
    site = Path(av.__file__).resolve().parent.parent
    members = verify_members(site, data['wheel']['members'])
    def library(stem):
        names = [n for n in members if n.startswith('av.libs/' + stem + '-')]
        if len(names) != 1:
            raise ValueError(f'Ambiguous bundled {stem}')
        return ctypes.CDLL(str(site / names[0]))
    util = library('libavutil')
    util.av_version_info.restype = ctypes.c_char_p
    version = util.av_version_info().decode()
    if version != '9.1':
        raise ValueError(f'Expected genuine FFmpeg9.1, found {version}')
    native_protocols = protocols(library('libavformat'))
    filters = set(av.filter.filters_available)
    if not filters <= FILTERS or not {'abuffer', 'abuffersink', 'aformat', 'aresample'} <= filters:
        raise ValueError(f'Unexpected/missing compiled filters: {sorted(filters)}')
    decoders = set()
    encoders = set()
    for name in av.codecs_available:
        for mode, found in (('r', decoders), ('w', encoders)):
            try:
                codec = av.Codec(name, mode)
            except (ValueError, av.error.FFmpegError):
                continue
            found.add(codec.name)
    if encoders or decoders != CODECS:
        raise ValueError(f'Unexpected compiled codecs: decoders={decoders}, encoders={encoders}')
    fixtures = [('pcm16-16k-mono', wav_fixture(16000, 1)),
                ('pcm16-48k-stereo', wav_fixture(48000, 2))]
    for item in source['sources']:
        if item['filename'].endswith(('.mp3', '.flac')):
            path = ROOT / 'fixtures' / item['filename']
            if path.stat().st_size != item['size'] or sha(path) != item['sha256']:
                raise ValueError('Changed codec fixture')
            fixtures.append((item['filename'], path.read_bytes()))
    results = []
    for name, raw in fixtures:
        resampler = av.AudioResampler(format='fltp', layout='mono', rate=16000)
        count = 0
        with av.open(io.BytesIO(raw)) as container:
            for frame in container.decode(audio=0):
                if frame.sample_rate > 192000 or frame.samples > 1024 * 1024:
                    raise ValueError('Unbounded fixture frame')
                count += sum(f.samples for f in resampler.resample(frame))
                if count > 16000 * 180:
                    raise ValueError('Fixture exceeds bounded decode duration')
            count += sum(f.samples for f in resampler.resample(None))
        if count <= 0:
            raise ValueError('No decoded/resampled fixture samples')
        results.append({'fixture': name, 'samples16kMono': count})
    serving_results = []
    if serving:
        import vllm
        package_root = Path(vllm.__file__).resolve().parent.parent
        for path, digest in source['servingSources'].items():
            if sha(package_root / path) != digest:
                raise ValueError(f'Unreviewed installed serving source: {path}')
        # Existing production admission guard remains required in the overlay.
        import sitecustomize
        verify_serving_guard(sitecustomize.__file__)
        from types import SimpleNamespace
        from vllm.entrypoints.speech_to_text.base.serving import SpeechToTextBaseServing
        server = SimpleNamespace(asr_config=SimpleNamespace(sample_rate=16000, allow_audio_chunking=False),
                                 max_audio_decode_duration_s=180, max_audio_decode_bytes=128 * 1024 * 1024)
        for name, raw in fixtures:
            chunks, duration = SpeechToTextBaseServing._decode_and_chunk_speech(server, raw)
            if len(chunks) != 1 or not 0 < duration <= 180:
                raise ValueError('Actual Whisper preprocessing failed')
            serving_results.append({'fixture': name, 'duration': duration, 'samples': chunks[0].size})
        for raw in (b'', b'<CompositionPlaylist/>', b'azmq=tcp://127.0.0.1:5555'):
            try:
                SpeechToTextBaseServing._decode_and_chunk_speech(server, raw)
            except (ValueError, av.error.FFmpegError):
                continue
            raise ValueError('Non-audio serving input accepted')
    return {'status': 'passed', 'ffmpegVersion': version, 'pyavVersion': av.__version__,
            'installedMemberCount': len(members), 'loadedCandidateElfs': loaded_closure(site, members),
            'compiledFilters': sorted(filters), 'compiledDecoders': sorted(decoders), 'compiledEncoders': [],
            'nativeProtocols': native_protocols, 'nativeMuxers': [], 'decodeResample': results,
            'whisperPreprocessing': serving_results,
            'scope': 'Candidate native capability/codec checks; no weights/model inference; independent full scan required'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--serving', action='store_true')
    args = parser.parse_args()
    try:
        result = inspect(args.serving)
    except Exception as error:
        result = {'status': 'failed', 'errorType': type(error).__name__, 'error': str(error)}
    with Path(args.output).open('x') as output:
        json.dump(result, output, indent=2)
        output.write('\n')
    sys.exit(0 if result['status'] == 'passed' else 1)
