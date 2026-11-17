#!/usr/bin/env python3
"""Install reviewed Anchore release binaries after verifying committed SHA-256 pins."""
import hashlib
import io
import os
import pathlib
import platform
import tarfile
import urllib.request

PINS = {
    'grype': ('0.122.0', {
        'linux_amd64': 'e697e6f7224637df87e267e4318cc027feae99a8e1b80280241d32b9ee5d4920',
        'linux_arm64': '7ebb44a7e69f8ca2491040e140a802117b2bf3ca8360d3856b3e0b9fe79962c4',
        'darwin_arm64': 'ca8907493c82181b0ceb6fe782ebdcb98b30dcd477319aaad7be89aa7590461b',
    }),
    'syft': ('1.57.2', {
        'linux_amd64': 'ad92bd3ec1b94a3df01d4d0aec199afa9c42b72e86da436ff5f837914d32706b',
        'linux_arm64': '8efe605309c98798e1ee0cffdcf8c05ca26819b4cd44c0b03650f1e963e9bdb6',
        'darwin_arm64': '38afbcc03a9d9afac2d7572432fd2c435e051e03930582ea90f4710ffb515224',
    }),
}


def install(destination):
    target = platform.system().lower() + '_' + {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}[platform.machine()]
    destination.mkdir(parents=True, exist_ok=True)
    for name, (version, checksums) in PINS.items():
        archive = f'{name}_{version}_{target}.tar.gz'
        payload = urllib.request.urlopen(f'https://github.com/anchore/{name}/releases/download/v{version}/{archive}', timeout=120).read()
        if hashlib.sha256(payload).hexdigest() != checksums[target]:
            raise ValueError(f'{name} checksum mismatch')
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as bundle:
            binary = bundle.extractfile(name).read()
        (destination / name).write_bytes(binary)
        (destination / name).chmod(0o755)


if __name__ == '__main__':
    install(pathlib.Path(os.environ['SECURITY_TOOLS_DIR']))
