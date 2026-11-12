"""Fetch installer code by the source commit bound to a verified public release.

A branch name is never an executable update target. The public Sigstore verifier
must succeed before any candidate code is loaded. Git then verifies the commit,
its tree and fetched blobs; no candidate code is executed during checkout.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile

import public_release


def git(*args, capture=False):
    environment = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
                       GIT_NO_REPLACE_OBJECTS='1', GIT_TERMINAL_PROMPT='0')
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null',
                           '-c', 'protocol.file.allow=never', *map(str, args)],
                          env=environment, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def check_checkout(directory, source):
    if directory.is_symlink() or (directory / '.git').is_symlink() or not (directory / '.git').is_dir():
        raise ValueError('Invalid installer source cache')
    if git('-C', directory, 'rev-parse', 'HEAD', capture=True).strip() != source:
        raise ValueError('Installer checkout does not match the verified source commit')
    if git('-C', directory, 'status', '--porcelain', '--untracked-files=all', capture=True).strip():
        raise ValueError('Installer source cache was modified; it will not be executed')


def fetch_verified_source(selected, directory):
    """Verify artifacts first, then return a fresh commit-pinned code checkout."""
    source = selected.get('source_sha', '')
    if not re.fullmatch(r'[a-f0-9]{40}', source):
        raise ValueError('Invalid release source commit')
    run, attempt = str(selected.get('run_id', '')), selected.get('run_attempt')
    if not re.fullmatch(r'[1-9][0-9]*', run) or type(attempt) is not int or attempt < 1:
        raise ValueError('Invalid release run identity')
    if selected.get('tag') != f'onprem-{source}-{run}-{attempt}':
        raise ValueError('Release tag does not match its verified identity')
    directory = Path(directory)
    if directory.is_symlink():
        raise ValueError('Installer cache must not be a symbolic link')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    artifacts = directory / ('release-' + str(selected['run_id']) + '-attempt-' + str(selected['run_attempt']))
    public_release.check_run(selected)
    public_release.download(selected, artifacts)
    # The independent, installed verifier is used rather than code in the
    # candidate checkout. It enforces repository/main/workflow/source/run/digest.
    subprocess.run([str(public_release.verifier_python()), str(public_release.VERIFIER),
                    source, str(selected['run_id']), str(selected['run_attempt']), str(artifacts),
                    str(artifacts / 'verified-images.json'),
                    str(artifacts / 'verified-inference.json')], check=True)
    destination = directory / ('source-' + source)
    if destination.exists() or destination.is_symlink():
        check_checkout(destination, source)
        return destination, artifacts
    with tempfile.TemporaryDirectory(prefix='.source-', dir=directory) as temporary:
        staging = Path(temporary) / 'checkout'
        git('init', '--initial-branch=main', staging)
        git('-C', staging, 'remote', 'add', 'origin',
            'https://github.com/' + public_release.REPOSITORY + '.git')
        git('-C', staging, 'sparse-checkout', 'init', '--cone')
        git('-C', staging, 'sparse-checkout', 'set', '.github', 'scripts', 'charts', 'infra', 'apps/inference/whisper')
        git('-C', staging, 'fetch', '--depth=1', '--filter=blob:none', 'origin', source)
        git('-C', staging, 'checkout', '--detach', source)
        check_checkout(staging, source)
        os.replace(staging, destination)
    return destination, artifacts
