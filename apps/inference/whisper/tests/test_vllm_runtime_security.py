import importlib.util
from pathlib import Path
import sys
from types import ModuleType

import pytest


spec = importlib.util.spec_from_file_location(
    'vllm_runtime_probe', Path(__file__).parents[4] / '.github/scripts/check-vllm-runtime.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


@pytest.mark.parametrize('version,path,rejects', [
    ('2.9.2', '/opt/videoq-audio/dns/__init__.py', True),
    ('2.9.1', '/opt/videoq-audio/dns/__init__.py', True),
    ('2.9.2', '/usr/local/lib/python3.12/dist-packages/dns/__init__.py', True),
    ('2.9.2', '/opt/videoq-audio/dns/__init__.py', False),
])
def test_runtime_probe_rejects_unpatched_or_misdirected_dns(monkeypatch, version, path, rejects):
    dns, exception, rdata = (ModuleType(name) for name in ('dns', 'dns.exception', 'dns.rdata'))
    dns.__file__ = path
    exception.SyntaxError = type('SyntaxError', (Exception,), {})
    def from_text(*args):
        assert args == ('IN', 'WKS', '10.0.0.1 udp 65536')
        if rejects:
            raise exception.SyntaxError('out of range')
    rdata.from_text = from_text
    dns.exception, dns.rdata = exception, rdata
    for name, module in [('dns', dns), ('dns.exception', exception), ('dns.rdata', rdata)]:
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setattr(probe.importlib.metadata, 'version', lambda name: version)
    if version == '2.9.2' and path.startswith('/opt/videoq-audio/') and rejects:
        assert probe.inspect_patched_dns(Path('/opt/videoq-audio'))['oversizedWksRejected'] is True
    else:
        with pytest.raises(ValueError):
            probe.inspect_patched_dns(Path('/opt/videoq-audio'))


def test_header_probe_reads_actual_file_and_rejects_symlink_elf_and_mode(tmp_path):
    location = Path(__file__).parents[4] / '.github/scripts/check-vllm-inventory.py'
    spec = importlib.util.spec_from_file_location('header_inventory_probe', location)
    inventory_probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inventory_probe)
    header = tmp_path / 'example.h'
    header.write_text('/* exported constant */\n')
    header.chmod(0o644)
    entry = inventory_probe.inspect_header_file(header, '/usr/include/linux/example.h')
    assert entry['mode'] == 0o644
    assert entry['sha256'] == inventory_probe.digest(header)
    link = tmp_path / 'link.h'
    link.symlink_to(header)
    with pytest.raises(ValueError, match='symlink'):
        inventory_probe.inspect_header_file(link, '/usr/include/linux/link.h')
    header.chmod(0o755)
    with pytest.raises(ValueError, match='executable'):
        inventory_probe.inspect_header_file(header, '/usr/include/linux/example.h')
    header.chmod(0o644)
    header.write_bytes(b'\x7fELFfake binary')
    with pytest.raises(ValueError, match='executable'):
        inventory_probe.inspect_header_file(header, '/usr/include/linux/example.h')
    header.write_text('not a header path')
    with pytest.raises(ValueError):
        inventory_probe.inspect_header_file(header, '/tmp/example.h')
