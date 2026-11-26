"""Validate a self-contained OCI rootfs against the exact loaded native smoke image."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess

INDEX = 'application/vnd.oci.image.index.v1+json'
MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
CONFIG = 'application/vnd.oci.image.config.v1+json'
LAYER = 'application/vnd.oci.image.layer.v1.tar'
MAX_BLOB = 2 * 1024**3
MAX_UNCOMPRESSED = 4 * 1024**3


def verify(directory, image=None, architecture=None, loaded=None):
    directory = Path(directory).absolute()
    if directory.is_symlink():
        raise ValueError('OCI root must not be a symlink')
    root = directory.resolve(strict=True)

    def contained(relative):
        path = root / relative
        for part in [path, *path.parents]:
            if part == root:
                break
            if part.is_symlink():
                raise ValueError('OCI files must not be symlinks')
        if not path.is_file() or not path.resolve(strict=True).is_relative_to(root):
            raise ValueError('Missing or external OCI content')
        return path

    def json_file(relative):
        path = contained(relative)
        if path.stat().st_size > 16 * 1024**2:
            raise ValueError('OCI metadata exceeds bound')
        return json.loads(path.read_bytes())

    def descriptor(desc, media):
        digest = desc.get('digest', '')
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
            raise ValueError('Require hexadecimal SHA256 OCI digest')
        if desc.get('mediaType') not in media or 'urls' in desc:
            raise ValueError('Unsupported or external OCI descriptor')
        size = desc.get('size')
        if type(size) is not int or not 0 <= size <= MAX_BLOB:
            raise ValueError('Invalid OCI descriptor size')
        if 'platform' in desc:
            platform = desc['platform']
            if platform.get('os') != 'linux' or platform.get('architecture') != architecture:
                raise ValueError('Descriptor platform mismatch')
        path = contained('blobs/sha256/' + digest[7:])
        if path.stat().st_size != size:
            raise ValueError('OCI descriptor size mismatch')
        hashed = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024**2), b''):
                hashed.update(chunk)
        if hashed.hexdigest() != digest[7:]:
            raise ValueError('OCI blob digest mismatch')
        return path

    def metadata(desc, media):
        path = descriptor(desc, [media])
        if path.stat().st_size > 16 * 1024**2:
            raise ValueError('OCI metadata exceeds bound')
        return json.loads(path.read_bytes())

    if json_file('oci-layout') != {'imageLayoutVersion': '1.0.0'}:
        raise ValueError('Unsupported OCI layout')
    index = json_file('index.json')
    if index.get('schemaVersion') != 2 or index.get('mediaType', INDEX) != INDEX or len(index.get('manifests', [])) != 1:
        raise ValueError('Require one OCI native manifest')
    manifest_descriptor = index['manifests'][0]
    manifest = metadata(manifest_descriptor, MANIFEST)
    if manifest.get('schemaVersion') != 2 or manifest.get('mediaType') != MANIFEST:
        raise ValueError('Unsupported OCI manifest')
    config_digest = manifest['config']['digest']
    config = metadata(manifest['config'], CONFIG)
    if config.get('architecture') != architecture or config.get('os') != 'linux':
        raise ValueError('OCI platform mismatch')
    rootfs = config.get('rootfs', {})
    layers = manifest.get('layers', [])
    diff_ids = rootfs.get('diff_ids', [])
    if rootfs.get('type') != 'layers' or not 1 <= len(layers) <= 64 or len(layers) != len(diff_ids):
        raise ValueError('OCI rootfs layer count mismatch')
    total_uncompressed = 0
    if sum(layer.get('size', MAX_BLOB + 1) for layer in layers) > 4 * 1024**3:
        raise ValueError('OCI image compressed content exceeds bound')
    for desc, expected in zip(layers, diff_ids):
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', expected):
            raise ValueError('Invalid rootfs diffID')
        path = descriptor(desc, [LAYER, LAYER + '+gzip'])
        hashed, size = hashlib.sha256(), 0
        opener = gzip.open if desc['mediaType'].endswith('+gzip') else open
        with opener(path, 'rb') as stream:
            for chunk in iter(lambda: stream.read(1024**2), b''):
                size += len(chunk)
                total_uncompressed += len(chunk)
                if total_uncompressed > 8 * 1024**3:
                    raise ValueError('OCI image uncompressed content exceeds bound')
                if size > MAX_UNCOMPRESSED:
                    raise ValueError('Uncompressed OCI layer exceeds bound')
                hashed.update(chunk)
        if 'sha256:' + hashed.hexdigest() != expected:
            raise ValueError('OCI rootfs diffID mismatch')
    if loaded is None:
        loaded = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
    if loaded['Id'] != config_digest or loaded['Architecture'] != architecture or loaded['Os'] != 'linux' or loaded.get('RootFS', {}).get('Layers') != diff_ids:
        raise ValueError('Loaded smoke image differs from scanned OCI rootfs')
    return {'manifestDigest': manifest_descriptor['digest'], 'configDigest': config_digest,
            'rootfsDiffIds': diff_ids, 'architecture': architecture, 'os': 'linux',
            'allLayerContentsVerified': True, 'loadedImageMatches': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('image')
    parser.add_argument('architecture', choices=['amd64', 'arm64'])
    args = parser.parse_args()
    print(json.dumps(verify(args.directory, args.image, args.architecture), indent=2))
