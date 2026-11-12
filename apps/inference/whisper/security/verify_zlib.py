"""Check the library actually loaded by Python in the final distroless image."""
from pathlib import Path
import ctypes
import gzip
import io
import zipfile
import zlib

assert zlib.ZLIB_RUNTIME_VERSION == '1.4', zlib.ZLIB_RUNTIME_VERSION
library = ctypes.CDLL('libz.so.1')
library.zlibVersion.restype = ctypes.c_char_p
assert library.zlibVersion() == b'1.4'
record = Path('/var/lib/dpkg/status.d/zlib1g').read_text()
assert 'Version: 1:1.4-0videoq1\n' in record
assert 'Source: zlib\n' in record
assert 'https://zlib.net/zlib-1.4.tar.gz' in Path('/usr/share/doc/videoq-native/zlib1g.source').read_text()
payload = bytes(range(256)) * 1024
for level in (0, 6, 9):
    assert zlib.decompress(zlib.compress(payload, level)) == payload
assert gzip.decompress(gzip.compress(payload)) == payload
archive = io.BytesIO()
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as package:
    package.writestr('fixture.bin', payload)
with zipfile.ZipFile(archive) as package:
    assert package.read('fixture.bin') == payload
print('zlib 1.4 verified; zlib, gzip and ZIP round trips retained')
