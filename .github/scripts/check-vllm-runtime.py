"""Inspect the unchanged upstream image without a GPU or downloaded weights.

Always emit a machine-readable result, including when optional imports fail.
"""
import contextlib
import importlib
import importlib.metadata
import json
from pathlib import Path
import sys


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

    def registry():
        from vllm.model_executor.models import ModelRegistry
        architectures = ("GptOssForCausalLM", "EmbeddingGemma2Model", "WhisperForConditionalGeneration")
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
