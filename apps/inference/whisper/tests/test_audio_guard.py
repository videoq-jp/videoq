import io
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace

import pytest


def load(monkeypatch):
    calls = []
    container = SimpleNamespace(streams=[SimpleNamespace(type='audio',codec_context=SimpleNamespace(name='pcm_s16le'))], close=lambda:None)
    av = SimpleNamespace(open=lambda *args, **kwargs: calls.append((args, kwargs)) or container)
    monkeypatch.setitem(sys.modules, 'av', av)
    runpy.run_path(str(Path(__file__).parents[1] / 'audio_guard.py'))
    return av.open, calls


def test_local_audio_limits_cannot_be_overridden(monkeypatch):
    guarded, calls = load(monkeypatch)
    assert guarded(io.BytesIO(b'wav'), options={'protocol_whitelist': 'rtsp,tcp'},
                   container_options={'format_whitelist': 'rtsp'}).streams[0].codec_context.name == 'pcm_s16le'
    assert calls[0][1]['options']['protocol_whitelist'] == 'file,pipe'
    assert calls[0][1]['container_options']['format_whitelist'] == 'mp3,wav,flac'
    assert calls[0][1]['options']['codec_whitelist'] == 'flac,mp3,mp3float,pcm_s16le'
    assert guarded.__videoq_audio_guard__ == 'local-audio-only-v2'


@pytest.mark.parametrize('kwargs', [
    {'file': 'rtsp://127.0.0.1/loop'}, {'file': 'http://127.0.0.1/playlist'},
    {'file': io.BytesIO(), 'format': 'rtsp'}, {'file': io.BytesIO(), 'mode': 'w'},
    {'file': io.BytesIO(), 'io_open': lambda *args: None},
])
def test_network_paths_and_custom_io_fail_before_decoder_or_network(monkeypatch, kwargs):
    guarded, calls = load(monkeypatch)
    with pytest.raises(ValueError):
        guarded(**kwargs)
    assert calls == []


@pytest.mark.parametrize('streams', [
    [],
    [SimpleNamespace(type='audio', codec_context=None)],
    [SimpleNamespace(type='audio', codec_context=SimpleNamespace(name='pcm_alaw'))],
    [SimpleNamespace(type='audio', codec_context=SimpleNamespace(name='pcm_bluray'))],
    [SimpleNamespace(type='video', codec_context=None)],
    [SimpleNamespace(type='audio', codec_context=SimpleNamespace(name='pcm_s16le')),
     SimpleNamespace(type='video', codec_context=SimpleNamespace(name='h264'))],
    [SimpleNamespace(type='audio', codec_context=SimpleNamespace(name='flac')),
     SimpleNamespace(type='audio', codec_context=None)],
])
def test_unavailable_unsupported_or_non_audio_stream_is_closed_before_decode(monkeypatch, streams):
    from unittest.mock import Mock
    container = SimpleNamespace(streams=streams, close=Mock(), decode=Mock())
    av = SimpleNamespace(open=lambda *args, **kwargs: container)
    monkeypatch.setitem(sys.modules, 'av', av)
    runpy.run_path(str(Path(__file__).parents[1] / 'audio_guard.py'))
    with pytest.raises(ValueError, match='unsupported audio codecs'):
        # If admission returns, downstream callers would begin native decoding.
        av.open(io.BytesIO(b'wav')).decode(audio=0)
    container.close.assert_called_once_with()
    container.decode.assert_not_called()


@pytest.mark.parametrize('codecs', [['mp3'], ['mp3float'], ['pcm_s16le'], ['flac'],
                                  ['pcm_s16le', 'flac']])
def test_supported_audio_contexts_remain_admitted_without_early_close(monkeypatch, codecs):
    from unittest.mock import Mock
    streams = [SimpleNamespace(type='audio', codec_context=SimpleNamespace(name=name)) for name in codecs]
    container = SimpleNamespace(streams=streams, close=Mock(), decode=Mock())
    av = SimpleNamespace(open=lambda *args, **kwargs: container)
    monkeypatch.setitem(sys.modules, 'av', av)
    runpy.run_path(str(Path(__file__).parents[1] / 'audio_guard.py'))
    assert av.open(io.BytesIO(b'audio')) is container
    container.close.assert_not_called()
    container.decode.assert_not_called()
