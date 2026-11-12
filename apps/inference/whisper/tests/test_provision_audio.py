import hashlib
import io
import json
from pathlib import Path
import zipfile

import pytest

import provision_audio as audio


def fixture(tmp_path, extra=None):
    original = Path(__file__).parents[4] / 'charts/videoq-inference/files/vllm-audio-wheels.json'
    manifest = json.loads(original.read_text())
    wheels = {}
    for package in manifest['packages']:
        buffer = io.BytesIO()
        name, version = package['name'], package['version']
        with zipfile.ZipFile(buffer, 'w') as wheel:
            wheel.writestr(f'{name}-{version}.dist-info/METADATA', f'Name: {name}\nVersion: {version}\n')
            wheel.writestr(f'{name}/__init__.py', '# fixture')
            if extra:
                wheel.writestr(*extra)
        wheels[package['filename']] = buffer.getvalue()
        package['size'] = len(buffer.getvalue())
        package['sha256'] = hashlib.sha256(buffer.getvalue()).hexdigest()
    manifest_path = tmp_path / 'wheels.json'
    manifest_path.write_text(json.dumps(manifest))
    lock = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    cache = tmp_path / 'cache'
    directory = cache / '.videoq-vllm-audio' / lock
    directory.mkdir(parents=True)
    for name, data in wheels.items():
        (directory / name).write_bytes(data)
    return manifest_path, cache, tmp_path / 'runtime', directory


def test_offline_restart_uses_hash_verified_cache_without_network(tmp_path, monkeypatch):
    manifest, cache, destination, _ = fixture(tmp_path)
    monkeypatch.setattr(audio.urllib.request, 'urlopen', lambda *a, **kw: pytest.fail('Offline restart attempted a download'))
    audio.provision(manifest, cache, destination)
    assert (destination / 'av/__init__.py').read_text() == '# fixture'
    receipt = json.loads((destination / '.videoq-audio.json').read_text())
    assert receipt['lockSha256'] == hashlib.sha256(manifest.read_bytes()).hexdigest()
    assert len(list(destination.glob('*.dist-info'))) == 4
    with pytest.raises(ValueError, match='must be empty'):
        audio.provision(manifest, cache, destination)


def test_corrupt_or_missing_cached_wheel_fails_before_install(tmp_path):
    manifest, cache, destination, directory = fixture(tmp_path)
    wheel = next(directory.iterdir())
    data = wheel.read_bytes()
    wheel.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
    with pytest.raises(ValueError, match='Missing or corrupt'):
        audio.provision(manifest, cache, destination)
    assert not destination.exists()
    wheel.unlink()
    with pytest.raises(ValueError, match='Missing or corrupt'):
        audio.provision(manifest, cache, destination)


@pytest.mark.parametrize('path', ['../escape.py', '/escape.py', 'av/../../escape.py', 'av\\escape.py', 'hook.pth', 'av.data/scripts/run'])
def test_rejects_wheel_traversal_startup_hooks_and_scripts(tmp_path, path):
    manifest, cache, destination, _ = fixture(tmp_path, (path, 'unsafe'))
    with pytest.raises(ValueError):
        audio.provision(manifest, cache, destination)
    assert not (tmp_path / 'escape.py').exists()


def test_download_identity_is_checked_before_caching(tmp_path, monkeypatch):
    package = {'filename': 'sample.whl', 'url': 'https://files.pythonhosted.org/sample.whl', 'size': 4, 'sha256': hashlib.sha256(b'good').hexdigest()}
    for data in [b'bad!', b'exceeds', b'short']:
        monkeypatch.setattr(audio.urllib.request, 'urlopen', lambda *a, **kw: io.BytesIO(data))
        with pytest.raises(ValueError):
            audio.cached_wheel(package, tmp_path, True)
        assert list(tmp_path.iterdir()) == []
    monkeypatch.setattr(audio.urllib.request, 'urlopen', lambda *a, **kw: io.BytesIO(b'good'))
    assert audio.cached_wheel(package, tmp_path, True).read_bytes() == b'good'


def test_manifest_cannot_replace_engine_or_use_unreviewed_sources(tmp_path):
    path, _, _, _ = fixture(tmp_path)
    original = json.loads(path.read_text())
    for mutate in [lambda r: r['packages'][0].update(name='vllm'),
                   lambda r: r['packages'][0].update(url='http://files.pythonhosted.org/av.whl'),
                   lambda r: r['packages'][0].update(url='https://attacker.example/av.whl'),
                   lambda r: r.update(platform='linux/arm64')]:
        value = json.loads(json.dumps(original))
        mutate(value)
        with pytest.raises(ValueError):
            audio.validate_manifest(value)
