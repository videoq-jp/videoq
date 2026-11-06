"""Verify the fixed zlib loaded by Python in the final distroless image."""
import ctypes
import gzip
from pathlib import Path
import zlib

assert zlib.ZLIB_RUNTIME_VERSION == '1.4', zlib.ZLIB_RUNTIME_VERSION
library = ctypes.CDLL('libz.so.1')
library.zlibVersion.restype = ctypes.c_char_p
assert library.zlibVersion() == b'1.4'
record = Path('/var/lib/dpkg/status.d/zlib1g').read_text()
assert 'Package: zlib1g\n' in record
assert 'Version: 1:1.4-0videoq1\n' in record
payload = bytes(range(256)) * 1024
assert zlib.decompress(zlib.compress(payload)) == payload
assert gzip.decompress(gzip.compress(payload)) == payload
print('zlib 1.4 verified: Python runtime, shared library, package record and gzip round trip')
