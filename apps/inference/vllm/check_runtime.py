"""Check the unmodified upstream image's VideoQ speech input path without a GPU."""
import io
import json
from contextlib import redirect_stdout
import sys
import wave
from importlib.metadata import version


def check():
    import numpy as np
    from vllm.multimodal.media.audio import load_audio

    # The gateway uploads mono PCM WAV at 16 kHz. Test that actual decoding path,
    # rather than requiring every optional codec/resampler in vllm[audio].
    samples = (np.sin(np.arange(1600) * (2 * np.pi * 440 / 16000)) * 8192).astype('<i2')
    audio = io.BytesIO()
    with wave.open(audio, 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(samples.tobytes())
    audio.seek(0)
    decoded, sample_rate = load_audio(audio, sr=16000)
    assert sample_rate == 16000, sample_rate
    assert decoded.shape == (1600,), decoded.shape
    assert np.isfinite(decoded).all()
    assert np.max(np.abs(decoded - samples.astype(np.float32) / 32768)) < 1e-4
    return {'vllm': version('vllm'), 'sample_rate': sample_rate,
            'samples': len(decoded), 'gateway_wav_decoding': 'passed'}


def emit_result():
    # Upstream imports may log to stdout. Keep those diagnostics on stderr so
    # the retained runtime report is a single JSON document for every vendor.
    with redirect_stdout(sys.stderr):
        result = check()
    print(json.dumps(result))


if __name__ == '__main__':
    emit_result()
