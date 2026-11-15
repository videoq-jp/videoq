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
