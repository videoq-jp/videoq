from unittest.mock import patch

import pytest

from worker_python.runtime_security import verify_hashlib_runtime


@pytest.mark.parametrize('version,fips,blocked', [
    ((3, 14, 10), 1, True), ((3, 14, 10), 0, False),
    ((3, 14, 11), 1, False), ((3, 12, 16), 1, False),
])
def test_only_affected_python_fips_combination_is_rejected(version, fips, blocked):
    with patch('worker_python.runtime_security.sys.version_info', version), \
         patch('worker_python.runtime_security._hashlib.get_fips_mode', return_value=fips):
        if blocked:
            with pytest.raises(RuntimeError, match='CVE-2026-119170'):
                verify_hashlib_runtime()
        else:
            verify_hashlib_runtime()
