import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[1] / 'security'
spec = importlib.util.spec_from_file_location('kernel_headers', ROOT / 'verify_kernel_headers.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def put(root, name, data):
    path = root / name.lstrip('/')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return name


def test_only_headers_and_documentation_are_assessed(tmp_path):
    paths = [put(tmp_path, '/usr/include/linux/types.h', b'typedef int example;'),
             put(tmp_path, '/usr/share/doc/linux-libc-dev/copyright', b'license')]
    assert module.verify(paths, tmp_path) == 2


@pytest.mark.parametrize('path,data', [('/usr/include/linux/hidden.h', b'\x7fELFcode'),
                                      ('/usr/bin/kernel-helper', b'executable'),
                                      ('/usr/include/linux/helper.py', b'code'),
                                      ('/usr/include/linux/driver.ko', b'module')])
def test_executable_or_unassessed_package_files_invalidate_vex(tmp_path, path, data):
    with pytest.raises(RuntimeError, match='Unassessed'):
        module.verify([put(tmp_path, path, data)], tmp_path)


def test_executable_permissions_and_symlinks_invalidate_assessment(tmp_path):
    name = put(tmp_path, '/usr/include/linux/types.h', b'header')
    path = tmp_path / name.lstrip('/')
    path.chmod(0o755)
    with pytest.raises(RuntimeError, match='Unassessed'):
        module.verify([name], tmp_path)
    path.unlink()
    target = tmp_path / 'unexpected.h'
    target.write_bytes(b'header')
    path.symlink_to(target)
    with pytest.raises(RuntimeError, match='Unassessed'):
        module.verify([name], tmp_path)


def test_kernel_binaries_and_modules_invalidate_vex(tmp_path):
    header = put(tmp_path, '/usr/include/linux/types.h', b'header')
    put(tmp_path, '/lib/modules/version/drivers/example.ko.xz', b'module')
    with pytest.raises(RuntimeError, match='binaries/modules'):
        module.verify([header], tmp_path)


def test_missing_inventory_fails_closed(tmp_path):
    with pytest.raises(RuntimeError, match='missing'):
        module.verify([], tmp_path)


def test_assessment_is_limited_to_explicit_cves_and_reviewed_header_versions():
    vex = json.loads((ROOT / 'kernel-headers.openvex.json').read_text())
    assert vex['statements']
    ids = set()
    reviewed = {
        'pkg:deb/ubuntu/linux-libc-dev@6.8.0-147.147?arch=amd64&distro=ubuntu-24.04': 386,
        'pkg:deb/ubuntu/linux-libc-dev@6.8.0-149.149?arch=amd64&distro=ubuntu-24.04': 385,
    }
    counts = dict.fromkeys(reviewed, 0)
    for statement in vex['statements']:
        name = statement['vulnerability']['name']
        assert name.startswith('CVE-') and '*' not in name
        assert name not in ids
        ids.add(name)
        products = [product['@id'] for product in statement['products']]
        assert products and len(products) == len(set(products))
        assert set(products) <= reviewed.keys()
        for product in products:
            counts[product] += 1
        assert statement['status'] == 'not_affected'
        assert statement['justification'] == 'vulnerable_code_not_present'
    assert counts == reviewed
