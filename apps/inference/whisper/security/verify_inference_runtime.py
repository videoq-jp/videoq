"""Exercise the serving imports without downloading weights or requiring a GPU."""
from importlib import import_module, metadata

EXPECTED = {
    "vllm": "0.32.0",
    "flashinfer-python": "0.7.0.post1",
    "flashinfer-cubin": "0.7.0.post1",
    "flashinfer-jit-cache": "0.7.0.post1+cu130",
}


def verify(version=metadata.version, load=import_module):
    for package, expected in EXPECTED.items():
        actual = version(package)
        if actual != expected:
            raise RuntimeError(f"{package}: expected {expected}, installed {actual}")
    for module in ("av", "soxr", "soundfile", "flashinfer",
                   "vllm.v1.attention.backends.flashinfer"):
        load(module)


if __name__ == "__main__":
    verify()
