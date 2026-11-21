import io
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace

import pytest


def load(monkeypatch):
    calls = []
    av = SimpleNamespace(open=lambda *args, **kwargs: calls.append((args, kwargs)) or 'decoded')
    monkeypatch.setitem(sys.modules, 'av', av)
    runpy.run_path(str(Path(__file__).parents[1] / 'audio_guard.py'))
    return av.open, calls


def test_local_audio_limits_cannot_be_overridden(monkeypatch):
    guarded, calls = load(monkeypatch)
    assert guarded(io.BytesIO(b'wav'), options={'protocol_whitelist': 'rtsp,tcp'},
                   container_options={'format_whitelist': 'rtsp'}) == 'decoded'
    assert calls[0][1]['options']['protocol_whitelist'] == 'file,pipe'
    assert calls[0][1]['container_options']['format_whitelist'] == 'mp3,wav,flac'
    assert guarded.__videoq_audio_guard__ == 'local-audio-only-v1'


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
