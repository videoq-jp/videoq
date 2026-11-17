"""Reject the affected FIPS configuration until CPython CVE-2026-119170 is fixed."""
import _hashlib
import sys


def verify_hashlib_runtime():
    if sys.version_info[:3] == (3, 14, 10) and _hashlib.get_fips_mode() != 0:
        raise RuntimeError('CVE-2026-119170: Python 3.14.10 cannot run this worker in FIPS mode')
