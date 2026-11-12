"""Collect exact-image evidence for applicability review; never suppress a CVE."""
import hashlib
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory():
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    packages = {}
    names = ('apt', 'libapt-pkg6.0t64', 'gpg', 'libssl3t64', 'openssl', 'linux-libc-dev')
    for name in names:
        packages[name] = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', name], text=True).strip()
    files = []
    paths = subprocess.check_output(['dpkg-query', '-L', 'linux-libc-dev'], text=True).splitlines()
    for value in paths:
        path = Path(value)
        if path.is_symlink():
            raise ValueError(f'Unreviewed kernel package symlink: {value}')
        if not path.is_file():
            continue
        allowed = (value.startswith('/usr/include/') and path.suffix == '.h') or value.startswith('/usr/share/doc/linux-libc-dev/')
        mode = path.stat().st_mode & 0o777
        with path.open('rb') as stream:
            magic = stream.read(4)
        if not allowed or mode & 0o111 or magic == b'\x7fELF' or '.ko' in path.suffixes:
            raise ValueError(f'Unreviewed kernel package executable: {value}')
        files.append({'path': value, 'mode': mode, 'sha256': digest(path)})
    if not files:
        raise ValueError('Missing kernel header inventory')
    if any(Path('/boot').glob('vmlinuz*')) or any(Path('/lib/modules').rglob('*.ko*')):
        raise ValueError('Kernel binaries/modules invalidate header-only review')
    canonical = json.dumps(sorted(files, key=lambda f: f['path']), sort_keys=True, separators=(',', ':')).encode()
    python = {}
    for name in ('vllm', 'msgpack', 'setuptools', 'urllib3'):
        distribution = importlib.metadata.distribution(name)
        spec = importlib.util.find_spec(name)
        python[name] = {'version': distribution.version, 'metadataPath': str(distribution._path), 'modulePath': spec.origin}
    pip_root = Path(importlib.util.find_spec('pip').origin).parent
    vendor_bom = pip_root / '_vendor/bom.cdx.json'
    components = json.loads(vendor_bom.read_text())['components']
    return {
        'os': {key: release[key].strip('"') for key in ('ID', 'VERSION_ID')},
        'packages': packages,
        'kernelHeaders': {'count': len(files), 'inventorySha256': hashlib.sha256(canonical).hexdigest(), 'files': files,
                          'kernelBinariesOrModules': False},
        'python': python,
        'pipVendor': {'path': str(vendor_bom), 'sha256': digest(vendor_bom),
                      'components': [{'name': c['name'], 'version': c.get('version')} for c in components]},
    }


if __name__ == '__main__':
    try:
        result = {'status': 'passed', 'inventory': inventory()}
    except Exception as error:
        result = {'status': 'failed', 'errorType': type(error).__name__, 'error': str(error)}
    print(json.dumps(result))
    sys.exit(0 if result['status'] == 'passed' else 1)
