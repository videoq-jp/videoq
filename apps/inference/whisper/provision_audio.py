"""Place hash-locked upstream wheels on a separate runtime volume; never build code.

Wheel archives are cached next to model weights for offline restarts. Only the
runtime volume is extracted; the upstream vLLM image remains unchanged.
"""
import argparse
import hashlib
from email.parser import BytesParser
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import urllib.parse
import urllib.request
import zipfile


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_manifest(manifest):
    if manifest.get('schemaVersion') != 1 or manifest.get('platform') != 'linux/amd64' or manifest.get('python') != '3.12':
        raise ValueError('Unsupported wheel manifest')
    if not re.fullmatch(r'vllm/vllm-openai@sha256:[a-f0-9]{64}', manifest.get('image', '')):
        raise ValueError('An exact upstream vLLM image is required')
    if {p['name'] for p in manifest['packages']} != {'av', 'scipy', 'soundfile', 'soxr'} or len(manifest['packages']) != 4:
        raise ValueError('Only the reviewed Whisper audio additions are permitted')
    for package in manifest['packages']:
        url = urllib.parse.urlsplit(package['url'])
        if url.scheme != 'https' or url.netloc != 'files.pythonhosted.org' or url.query or url.fragment:
            raise ValueError('Wheels must come from PyPI')
        if Path(url.path).name != package['filename'] or Path(package['filename']).name != package['filename'] or not package['filename'].endswith('.whl'):
            raise ValueError('Unexpected wheel filename')
        if not re.fullmatch(r'[a-f0-9]{64}', package['sha256']) or not 0 < package['size'] <= 100 * 1024**2:
            raise ValueError('Invalid wheel identity')


def cached_wheel(package, cache, download):
    path = cache / package['filename']
    if path.is_file() and path.stat().st_size == package['size'] and sha256(path) == package['sha256']:
        return path
    if not download:
        raise ValueError(f"Missing or corrupt cached wheel: {package['filename']}")
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            with urllib.request.urlopen(package['url'], timeout=120) as response:
                count = 0
                while chunk := response.read(1024**2):
                    count += len(chunk)
                    if count > package['size']:
                        raise ValueError('Wheel exceeds its locked size')
                    stream.write(chunk)
            stream.flush()
            if count != package['size'] or sha256(temporary) != package['sha256']:
                raise ValueError('Wheel checksum or size mismatch')
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    return path


def extract_wheel(path, package, destination):
    with zipfile.ZipFile(path) as wheel:
        entries = wheel.infolist()
        if sum(e.file_size for e in entries) > 512 * 1024**2:
            raise ValueError('Expanded wheel exceeds limit')
        metadata = [e for e in entries if e.filename.endswith('.dist-info/METADATA')]
        if len(metadata) != 1:
            raise ValueError('Wheel must contain one distribution')
        info = BytesParser().parsebytes(wheel.read(metadata[0]))
        if info['Name'].lower().replace('-', '_') != package['name'].replace('-', '_') or info['Version'] != package['version']:
            raise ValueError('Wheel metadata does not match the lock')
        for entry in entries:
            name = PurePosixPath(entry.filename)
            if name.is_absolute() or '..' in name.parts or '\\' in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('Unsafe wheel path')
            if not name.parts or entry.is_dir():
                continue
            if name.suffix == '.pth':
                raise ValueError('Wheel startup hooks are not permitted')
            if name.parts[0].endswith('.data'):
                if len(name.parts) < 3 or name.parts[1] not in {'purelib', 'platlib'}:
                    raise ValueError('Wheel scripts and system data are not permitted')
                name = PurePosixPath(*name.parts[2:])
            target = destination.joinpath(*name.parts)
            if target.exists():
                raise ValueError(f'Duplicate wheel path: {name}')
            target.parent.mkdir(parents=True, exist_ok=True)
            with wheel.open(entry) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)


def provision(manifest_path, cache_root, destination, download=False):
    raw = manifest_path.read_bytes()
    manifest = json.loads(raw)
    validate_manifest(manifest)
    lock = hashlib.sha256(raw).hexdigest()
    cache = cache_root / '.videoq-vllm-audio' / lock
    paths = [(p, cached_wheel(p, cache, download)) for p in manifest['packages']]
    destination.mkdir(parents=True, exist_ok=True)
    # The init container writes to a fresh emptyDir; never overlay existing code.
    if any(destination.iterdir()):
        raise ValueError('Audio runtime destination must be empty')
    for package, path in paths:
        extract_wheel(path, package, destination)
    (destination / '.videoq-audio.json').write_text(json.dumps({'lockSha256': lock, 'manifest': manifest}))
    return lock


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    print(provision(args.manifest, args.cache, args.destination, args.download))
