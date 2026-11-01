"""Fail closed if the narrowly assessed UAPI package gains executable code."""
import json
from pathlib import Path
import subprocess


def verify(paths, root=Path('/')):
    files = 0
    for value in paths:
        path = root / value.lstrip('/')
        if not path.is_file():
            continue
        allowed = value.startswith('/usr/include/') or value.startswith('/usr/share/doc/linux-libc-dev/')
        if not allowed or path.read_bytes()[:4] == b'\x7fELF' or '.ko' in path.suffixes:
            raise RuntimeError(f'Unassessed kernel package artifact: {value}')
        files += 1
    if not files:
        raise RuntimeError('Kernel header inventory is missing')
    if any(path.is_file() for path in (root / 'boot').glob('vmlinuz*')) or any((root / 'lib/modules').rglob('*.ko*')):
        raise RuntimeError('Kernel binaries/modules invalidate the header-only assessment')
    return files


if __name__ == '__main__':
    paths = subprocess.check_output(['dpkg-query', '-L', 'linux-libc-dev'], text=True).splitlines()
    version = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', 'linux-libc-dev'], text=True)
    print(json.dumps({'package': 'linux-libc-dev', 'version': version, 'header_documentation_files': verify(paths)}))
