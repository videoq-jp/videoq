"""Persist adopted application images inside the lab, before publishing Git changes.

The loopback-only Distribution registry is a K3s mirror for ghcr.io. Copy the
original OCI graph without rebuilding or changing its signed manifest digest.
No GitHub account, write token or public deployment registration is needed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

REGISTRY = '127.0.0.1:5000'
STORE = Path('/var/lib/videoq-image-store')
ORAS = '/usr/local/bin/videoq-oras'
COMPONENTS = {'api', 'worker', 'web', 'transcription-gateway'}


def application_refs(images):
    if set(images) != COMPONENTS:
        raise ValueError('Expected exactly four application images')
    refs = []
    for name, image in sorted(images.items()):
        repository = 'ghcr.io/videoq-jp/videoq-' + name
        if image.get('repository') != repository or not re.fullmatch(r'sha256:[a-f0-9]{64}', image.get('digest', '')):
            raise ValueError('Invalid application image identity')
        refs.append(repository + '@' + image['digest'])
    return refs


def local_ref(reference):
    if not re.fullmatch(r'ghcr.io/videoq-jp/videoq-(api|worker|web|transcription-gateway)@sha256:[a-f0-9]{64}', reference):
        raise ValueError('Invalid application image reference')
    return REGISTRY + '/' + reference.split('/', 1)[1]


def descriptor(reference):
    raw = subprocess.check_output([ORAS, 'manifest', 'fetch', '--descriptor', '--plain-http', reference], text=True, timeout=300)
    return json.loads(raw)['digest']


def verify_local(reference):
    expected = reference.split('@')[1]
    if descriptor(reference) != expected:
        raise ValueError('Local OCI manifest differs from the signed upstream digest')
    # Verify the complete graph rather than just its root manifest. This also
    # proves a previously stored release usable when upstream is inaccessible.
    with tempfile.TemporaryDirectory(prefix='videoq-oci-verify-') as temporary:
        subprocess.run([ORAS, 'copy', '--recursive', '--from-plain-http', '--to-oci-layout',
                        reference, temporary + ':verified'], check=True, timeout=10800)


def preserve(images):
    refs = application_refs(images)
    for source in refs:
        target = local_ref(source)
        try:
            verify_local(target)
            continue
        except (subprocess.CalledProcessError, ValueError, KeyError):
            pass
        repository, digest = target.split('@')
        subprocess.run([ORAS, 'copy', '--recursive', '--to-plain-http', source,
                        repository + ':sha256-' + digest.split(':')[1]], check=True, timeout=10800)
        verify_local(target)
    return refs


def stage(site, directory=STORE):
    lock = json.loads((site / 'release-lock.json').read_text())
    resources = (site / 'videoq/resources.json').read_bytes()
    if hashlib.sha256(resources).hexdigest() != lock['renderedFilesSha256']['videoq/resources.json']:
        raise ValueError('Generated resources changed after verification')
    refs = application_refs(lock['applicationImages'])
    objects = json.loads(resources)['items']
    found = set()
    for obj in objects:
        pod = obj.get('spec', {}).get('template', {}).get('spec', {})
        if obj['kind'] == 'CronJob':
            pod = obj['spec']['jobTemplate']['spec']['template']['spec']
        for c in pod.get('containers', []) + pod.get('initContainers', []):
            if c['image'].startswith('ghcr.io/videoq-jp/videoq-'):
                found.add(c['image'])
    if found != set(refs):
        raise ValueError('Rendered application images differ from the verified release')
    if not re.fullmatch(r'[a-f0-9]{40}', lock['sourceSha']) or not re.fullmatch(r'[1-9][0-9]*', str(lock['runId'])) or type(lock['runAttempt']) is not int or lock['runAttempt'] < 1:
        raise ValueError('Invalid release identity')
    preserve(lock['applicationImages'])
    receipt = {'schemaVersion': 1, **{k: lock[k] for k in ('sourceSha', 'runId', 'runAttempt')},
               'images': lock['applicationImages'], 'registry': REGISTRY}
    releases = directory / 'releases'
    releases.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = releases / (lock['sourceSha'] + '-' + str(lock['runId']) + '-' + str(lock['runAttempt']) + '.json')
    staging = path.with_suffix('.partial')
    staging.write_text(json.dumps(receipt, indent=2) + '\n'); staging.chmod(0o600)
    os.replace(staging, path)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site-directory', required=True, type=Path)
    args = parser.parse_args()
    stage(args.site_directory)
    print('All four signed application image graphs are stored in the lab. No GitHub write access was used.')


if __name__ == '__main__':
    main()
