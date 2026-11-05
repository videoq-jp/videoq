"""Require Ubuntu's actual APT fix in the NVIDIA image, independent of scanner lag."""
import json
from pathlib import Path
import subprocess

FIXED = '2.8.4ubuntu0.1'
PACKAGES = {'apt', 'libapt-pkg6.0t64'}


def verify(packages, release):
    if release.get('ID') != 'ubuntu' or release.get('VERSION_ID') != '24.04':
        raise ValueError('APT fix verification is scoped to Ubuntu 24.04')
    if len(packages) != 2 or {p['name'] for p in packages} != PACKAGES:
        raise ValueError('Missing or duplicate APT package records')
    for package in packages:
        if package['architecture'] != 'amd64' or package['status'] != 'installed':
            raise ValueError('NVIDIA APT packages must be installed amd64 packages')
        if subprocess.run(['dpkg', '--compare-versions', package['version'], 'ge', FIXED], check=False).returncode:
            raise ValueError('APT package predates the Ubuntu security fix: ' + package['name'])
    return packages


def main():
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    release = {key: value.strip('"') for key, value in release.items()}
    output = subprocess.check_output(['dpkg-query', '-W', '-f', '${Package}\t${Version}\t${Architecture}\t${db:Status-Status}\n',
                                      'apt', 'libapt-pkg6.0t64'], text=True)
    packages = [dict(zip(('name', 'version', 'architecture', 'status'), line.split('\t'), strict=True))
                for line in output.splitlines()]
    print(json.dumps({'aptSecurityFix': FIXED, 'packages': verify(packages, release)}, sort_keys=True))


if __name__ == '__main__':
    main()
