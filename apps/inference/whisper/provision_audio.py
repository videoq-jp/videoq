"""Copy locked upstream codecs into an offline, read-only ROCm speech payload.

Do not copy the gateway's CPU PyTorch/NumPy into the ROCm interpreter. Both
images use CPython 3.12; CI checks this payload in the actual upstream image.
"""
import json
from importlib.metadata import distribution
from pathlib import Path
import platform
import shutil
import sys

PACKAGES = ('soundfile', 'cffi', 'pycparser', 'typing-extensions')


def provision(target=Path('/audio-deps')):
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError('The reviewed ROCm audio payload requires CPython 3.12')
    target.mkdir(parents=True, exist_ok=True)
    versions = {}
    for name in PACKAGES:
        package = distribution(name)
        if not package.files:
            raise RuntimeError(f'Missing package inventory: {name}')
        for record in package.files:
            relative = Path(record)
            if relative.is_absolute():
                raise RuntimeError(f'Unsafe codec package path: {record}')
            if '..' in relative.parts:
                # Wheel RECORD may include ../bin entry points (e.g. cffi-gen-src).
                # They are installation tools, not runtime codec imports.
                continue
            source = package.locate_file(record)
            if not source.is_file():
                raise RuntimeError(f'Missing codec package file: {record}')
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        versions[name] = package.version
    manifest = {'python': platform.python_version(), 'machine': platform.machine(), 'packages': versions}
    (target / 'videoq-audio.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    print(json.dumps(provision(Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/audio-deps'))))
