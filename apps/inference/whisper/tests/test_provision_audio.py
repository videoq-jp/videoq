import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import provision_audio


def test_locked_codec_payload_includes_inventory_and_excludes_inference_runtimes(tmp_path):
    manifest = provision_audio.provision(tmp_path)
    assert manifest['packages']['soundfile'] == '0.14.0'
    assert json.loads((tmp_path / 'videoq-audio.json').read_text()) == manifest
    assert (tmp_path / 'soundfile.py').is_file()
    assert (tmp_path / '_soundfile_data').is_dir()
    assert any(tmp_path.glob('_cffi_backend*.so'))
    assert not (tmp_path / 'torch').exists()
    assert not (tmp_path / 'numpy').exists()


def test_wheel_entry_points_are_not_exported_outside_payload(tmp_path, monkeypatch):
    source = tmp_path / 'source'
    source.write_text('codec')
    package = SimpleNamespace(files=[Path('../../../bin/tool'), Path('codec.py')],
                              version='1', locate_file=lambda _: source)
    monkeypatch.setattr(provision_audio, 'PACKAGES', ('codec',))
    monkeypatch.setattr(provision_audio, 'distribution', lambda _: package)
    target = tmp_path / 'payload'
    provision_audio.provision(target)
    assert (target / 'codec.py').read_text() == 'codec'
    assert sorted(p.name for p in target.iterdir()) == ['codec.py', 'videoq-audio.json']


def test_absolute_package_paths_fail_without_marking_payload_ready(tmp_path, monkeypatch):
    package = SimpleNamespace(files=[Path('/outside')], version='1')
    monkeypatch.setattr(provision_audio, 'distribution', lambda _: package)
    with pytest.raises(RuntimeError, match='Unsafe codec package path'):
        provision_audio.provision(tmp_path)
    assert not (tmp_path / 'videoq-audio.json').exists()


def test_changed_python_abi_requires_a_new_codec_review(tmp_path, monkeypatch):
    monkeypatch.setattr(provision_audio.sys, 'version_info', (3, 13))
    with pytest.raises(RuntimeError, match='CPython 3.12'):
        provision_audio.provision(tmp_path)
