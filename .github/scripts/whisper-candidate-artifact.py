"""Prove the loaded smoke target is the exact native OCI artifact to scan/publish."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def verify(directory, image, architecture):
    def blob(digest):
        algorithm, value = digest.split(':')
        if algorithm != 'sha256' or len(value) != 64:
            raise ValueError('Require SHA256 OCI blobs')
        data = (directory / 'blobs' / algorithm / value).read_bytes()
        if hashlib.sha256(data).hexdigest() != value:
            raise ValueError('OCI blob digest mismatch')
        return json.loads(data)

    index = json.loads((directory / 'index.json').read_text())
    if len(index['manifests']) != 1:
        raise ValueError('Require exactly one native image manifest')
    digest = index['manifests'][0]['digest']
    manifest = blob(digest)
    config_digest = manifest['config']['digest']
    config = blob(config_digest)
    loaded = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
    if config['architecture'] != architecture or config['os'] != 'linux':
        raise ValueError('OCI platform mismatch')
    if loaded['Id'] != config_digest or loaded['Architecture'] != architecture:
        raise ValueError('Loaded smoke image differs from scanned OCI artifact')
    return {'manifestDigest': digest, 'configDigest': config_digest,
            'architecture': architecture, 'os': 'linux', 'loadedImageMatches': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('image')
    parser.add_argument('architecture', choices=['amd64', 'arm64'])
    args = parser.parse_args()
    print(json.dumps(verify(args.directory, args.image, args.architecture), indent=2))
