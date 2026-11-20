"""Trusted startup guard for the locked vLLM audio overlay.

The private gateway supports local MP3/WAV/FLAC uploads. Never allow PyAV to
enter a network demuxer, including the RTSP redirect path in CVE-2026-107696.
"""
import os
from urllib.parse import urlsplit
import av

_original_open = av.open
_ALLOWED_CODECS = frozenset({'mp3', 'mp3float', 'pcm_s16le', 'flac'})


def local_audio_open(file, mode='r', format=None, options=None, container_options=None, **kwargs):
    if mode not in ('r', None) or format not in (None, 'mp3', 'wav', 'flac'):
        raise ValueError('VideoQ PyAV accepts only local MP3/WAV/FLAC input')
    if isinstance(file, (str, bytes, os.PathLike)) and urlsplit(os.fsdecode(file)).scheme:
        raise ValueError('VideoQ PyAV does not accept network URLs')
    if kwargs.get('io_open') is not None:
        raise ValueError('Custom I/O callbacks are outside the reviewed audio path')
    limits = {'protocol_whitelist': 'file,pipe', 'format_whitelist': 'mp3,wav,flac',
              'codec_whitelist': ','.join(sorted(_ALLOWED_CODECS))}
    container = _original_open(file, mode=mode, format=format,
                               options={**(options or {}), **limits},
                               container_options={**(container_options or {}), **limits}, **kwargs)
    # A WAV demuxer can advertise codecs other than PCM. Reject those too,
    # before callers can open/decode an unsupported stream.
    try:
        if not container.streams or any(stream.type != 'audio' or stream.codec_context.name not in _ALLOWED_CODECS
                                        for stream in container.streams):
            raise ValueError('VideoQ PyAV rejects unsupported audio codecs')
    except BaseException:
        container.close()
        raise
    return container


local_audio_open.__videoq_audio_guard__ = 'local-audio-only-v2'
av.open = local_audio_open
