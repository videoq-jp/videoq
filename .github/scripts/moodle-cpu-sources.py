"""Prepare public, commit-pinned Moodle sources in a fresh external build directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PINS = ROOT / '.github/moodle-cpu/pins.json'
REPOSITORIES = {'moodle': 'https://github.com/moodle/moodle.git',
                'companion': 'https://github.com/videoq-jp/videoq-moodle.git'}


def read_pins(path=PINS):
    pins = json.loads(path.read_text())
    if set(pins) != {'moodle', 'companion', 'phpImage', 'proxyImage'}:
        raise ValueError('Unexpected Moodle fixture pins')
    for component, repository in REPOSITORIES.items():
        source = pins[component]
        if set(source) != {'repository', 'revision'} or source['repository'] != repository:
            raise ValueError('Unexpected public source repository')
        if not re.fullmatch('[a-f0-9]{40}', source['revision']):
            raise ValueError('Moodle sources require full immutable commit identities')
    for field, prefix in [('phpImage', 'moodlehq/moodle-php-apache:8.3@'), ('proxyImage', 'caddy:2-alpine@')]:
        if not re.fullmatch(re.escape(prefix) + 'sha256:[a-f0-9]{64}', pins[field]):
            raise ValueError('Moodle runtime images require reviewed digests')
    return pins


def prepare(output):
    pins = read_pins()
    output = Path(output)
    if not output.is_absolute() or output.is_symlink():
        raise ValueError('Use an absolute external build directory')
    resolved = output.resolve()
    if resolved == ROOT or ROOT in resolved.parents or (resolved.exists() and any(resolved.iterdir())):
        raise ValueError('Build directory must be empty and outside the checkout')
    resolved.mkdir(mode=0o700, parents=True, exist_ok=True)
    resolved.chmod(0o700)
    # Disable stored Git configuration, credential helpers and trace variables
    # for these explicit public repositories.
    env = {name: value for name, value in os.environ.items() if name in ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']}
    env.update({'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0'})
    def run(command, label):
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=180)
        (resolved / (label + '.log')).write_bytes(result.stdout + result.stderr)
        if result.returncode:
            raise RuntimeError('Pinned Moodle source preparation failed: ' + label)
        return result.stdout.decode().strip()
    (resolved / '.videoq-moodle-cpu-build').write_text('Public sources and test fixture only\n')
    sources = {}
    for component in REPOSITORIES:
        source = pins[component]
        checkout = resolved / ('git-' + component)
        run(['git', 'init', '--quiet', str(checkout)], component + '-init')
        run(['git', '-C', str(checkout), '-c', 'credential.helper=', '-c', 'http.extraheader=',
             'fetch', '--quiet', '--depth=1', source['repository'], source['revision']], component + '-fetch')
        actual = run(['git', '-C', str(checkout), 'rev-parse', 'FETCH_HEAD'], component + '-revision')
        if actual != source['revision']:
            raise RuntimeError('Fetched Moodle source identity mismatch')
        archive = resolved / (component + '.tar')
        run(['git', '-C', str(checkout), 'archive', '--format=tar', '--output=' + str(archive), actual], component + '-archive')
        destination = resolved / component
        destination.mkdir(mode=0o700)
        run(['tar', '-xf', str(archive), '-C', str(destination)], component + '-extract')
        checksum = hashlib.sha256()
        with archive.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(chunk)
        sources[component] = {'repository': source['repository'], 'revision': actual,
                              'archiveSha256': checksum.hexdigest()}
        archive.unlink()
        shutil.rmtree(checkout)
    fixture = resolved / 'fixture'
    fixture.mkdir()
    for name in ['moodle-config.php', 'entrypoint.sh', 'fixture.php']:
        shutil.copyfile(ROOT / '.github/moodle-cpu' / name, fixture / name)
    shutil.copyfile(ROOT / '.github/moodle-cpu/Dockerfile', resolved / 'Dockerfile')
    (resolved / '.dockerignore').write_text('*.log\nsource-identities.json\n.videoq-moodle-cpu-build\n')
    result = {'sources': sources, 'phpImage': pins['phpImage'], 'proxyImage': pins['proxyImage'],
              'limits': ['Prepared sources and image build context only; no Moodle install, model download or AI acceptance.']}
    (resolved / 'source-identities.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = prepare(args.output)
    print(json.dumps(result, indent=2))
