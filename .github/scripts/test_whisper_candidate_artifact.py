import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('whisper-candidate-artifact.py'))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class ArtifactIdentityTest(unittest.TestCase):
    def fixture(self, root):
        (root / 'blobs/sha256').mkdir(parents=True)
        (root / 'oci-layout').write_text('{"imageLayoutVersion":"1.0.0"}')

        def write_blob(data, media):
            if isinstance(data, dict):
                data = json.dumps(data).encode()
            digest = hashlib.sha256(data).hexdigest()
            (root / 'blobs/sha256' / digest).write_bytes(data)
            return {'digest': 'sha256:' + digest, 'size': len(data), 'mediaType': media}

        layers, diff_ids = [], []
        for content in (b'first', b'second'):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w') as tar:
                info = tarfile.TarInfo('file'); info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
            tar_bytes = output.getvalue()
            layers.append(write_blob(gzip.compress(tar_bytes), candidate.LAYER + '+gzip'))
            diff_ids.append('sha256:' + hashlib.sha256(tar_bytes).hexdigest())
        config = {'architecture': 'arm64', 'os': 'linux', 'rootfs': {'type': 'layers', 'diff_ids': diff_ids}}
        manifest = {'schemaVersion': 2, 'mediaType': candidate.MANIFEST,
                    'config': write_blob(config, candidate.CONFIG), 'layers': layers}
        loaded = {'Id': manifest['config']['digest'], 'Architecture': 'arm64', 'Os': 'linux', 'RootFS': {'Layers': diff_ids}}

        def index(value=manifest, change=None):
            desc = write_blob(value, candidate.MANIFEST)
            desc['platform'] = {'os': 'linux', 'architecture': 'arm64'}
            if change:
                change(desc)
            (root / 'index.json').write_text(json.dumps({'schemaVersion': 2, 'mediaType': candidate.INDEX, 'manifests': [desc]}))
        index()
        return manifest, loaded, index, write_blob

    def test_valid_native_gzip_and_loaded_rootfs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest, loaded, index, write = self.fixture(root)
            self.assertTrue(candidate.verify(root, architecture='arm64', loaded=loaded)['allLayerContentsVerified'])
            bad = copy.deepcopy(loaded); bad['RootFS']['Layers'].reverse()
            with self.assertRaisesRegex(ValueError, 'Loaded smoke image differs'):
                candidate.verify(root, architecture='arm64', loaded=bad)

    def test_invalid_layer_and_descriptor_controls(self):
        controls = ['alternate', 'missing', 'modified', 'order', 'count', 'size', 'foreign', 'media', 'config-size', 'platform', 'manifest-size', 'config-media', 'digest-path', 'schema', 'layout', 'layout-missing', 'loaded-id']
        for control in controls:
            with self.subTest(control=control), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); m, loaded, index, write = self.fixture(root)
                if control == 'alternate':
                    m['layers'][0] = write(gzip.compress(b'other complete stream'), candidate.LAYER + '+gzip')
                elif control in ('missing', 'modified'):
                    p = root / 'blobs/sha256' / m['layers'][0]['digest'][7:]
                    if control == 'missing': p.unlink()
                    else: p.write_bytes(b'x' * m['layers'][0]['size'])
                elif control == 'order': m['layers'].reverse()
                elif control == 'count': m['layers'].pop()
                elif control == 'size': m['layers'][0]['size'] += 1
                elif control == 'foreign': m['layers'][0]['urls'] = ['https://example.invalid/foreign']
                elif control == 'media': m['layers'][0]['mediaType'] = 'application/vnd.docker.image.rootfs.foreign.diff.tar.gzip'
                elif control == 'config-size': m['config']['size'] += 1
                elif control == 'config-media': m['config']['mediaType'] = candidate.LAYER
                elif control == 'digest-path': m['config']['digest'] = 'sha256:' + '../' * 21 + 'x'
                elif control == 'schema': m['schemaVersion'] = 1
                elif control == 'layout': (root / 'oci-layout').write_text('{}')
                elif control == 'layout-missing': (root / 'oci-layout').unlink()
                elif control == 'loaded-id': loaded['Id'] = 'sha256:' + '0' * 64
                change = None
                if control == 'platform': change = lambda d: d.update(platform={'os': 'windows', 'architecture': 'amd64'})
                if control == 'manifest-size': change = lambda d: d.update(size=1)
                index(m, change)
                with self.assertRaises((ValueError, FileNotFoundError)):
                    candidate.verify(root, architecture='arm64', loaded=loaded)

    def test_external_symlink_controls(self):
        for target in ['manifest', 'config', 'layer', 'blob-directory']:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as external:
                root = Path(directory); m, loaded, index, write = self.fixture(root)
                if target == 'blob-directory':
                    path = root / 'blobs/sha256'; path.rename(Path(external) / 'sha256'); path.symlink_to(Path(external) / 'sha256', target_is_directory=True)
                else:
                    desc = {'manifest': json.loads((root / 'index.json').read_text())['manifests'][0], 'config': m['config'], 'layer': m['layers'][0]}[target]
                    path = root / 'blobs/sha256' / desc['digest'][7:]
                    outside = Path(external) / 'blob'; path.rename(outside); path.symlink_to(outside)
                with self.assertRaisesRegex(ValueError, 'symlinks'):
                    candidate.verify(root, architecture='arm64', loaded=loaded)
