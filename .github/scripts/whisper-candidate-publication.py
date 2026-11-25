"""Fixed-scope, fixed-run publication authorization; never executes candidate code."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess

REPOSITORY = 'videoq-jp/videoq'
PACKAGE = 'ghcr.io/videoq-jp/videoq-whispercpp-candidate'
RUN = 45538276974
HEAD = '83aa79e99b14cbdd15d2647a724b5f2c221f26e3'
SOURCE = '48d69177d7dfc675c13870457ad172b90c907529'
ATTEMPT = 1
CANDIDATES = {'amd64': {'artifact': 14987837441,
           'archiveDigest': 'sha256:c8ee13a996d27a91c773baf9f639b5627a98fadc811c4f2ad1d2426c4165b7c7',
           'manifest': 'sha256:8a0500db924c9974e02cc1ace538743cb86101784b961a564c27c401859435f3',
           'upstream': 'ghcr.io/ggml-org/whisper.cpp@sha256:0b39b82d8febd2708a5abd2e3d8d373620604d558922f2cf921b7f4c365e6c73',
           'evidenceHashes': {'identity.json': '9ba5b110f98a59c3329e6913632e55e0460befef1375208d845d03318a514543',
                              'runtime-receipt.json': '69ab7d6fbcd0d50c809e0ae1dc54c5bd43a16cc3f1bd55b96f4da40874eda1a1',
                              'security.json.syft.json': '5b4a16bceb8a554d008404a3e51a37198ce8aa4c36b9b5dacd029d48d0f5626d',
                              'security.json.grype.json': '979f0ec0fba33797f87f4bc5e2f73d25198518442b2ef97a92af9529d9b95178'}},
 'arm64': {'artifact': 14988555960,
           'archiveDigest': 'sha256:fb411fd3cca8181cd50a5d8e2d82a1a07cb487dbe61f7ee854bc80e8cb17e0c0',
           'manifest': 'sha256:4ce5623785e0ecd1dace26f7ead5e3f13688ed5ba6a0e23f7fae1bf83ddb420d',
           'upstream': 'ghcr.io/ggml-org/whisper.cpp@sha256:f0fed3d3d54565cb37d2995fcaa28ca09a5c9f3ffb7fada2d790099af2bfeee0',
           'evidenceHashes': {'identity.json': '56126b2710a4896d5cfbace82fb78d26ee6d4bbc0e61b18d5ca94e43f278b589',
                              'runtime-receipt.json': '8d7c9b548522b7026d5f1fa20a629bef1daffc05b0d64ac444973838641755d2',
                              'security.json.syft.json': 'db29c486f1ba17eba1ba2286b1e3303810d55374822d83e2ef11b938ffa8768a',
                              'security.json.grype.json': '57fdbb149d137980860a8389659247120a6e2dd46337fe62e73fd5eb1bc32086'}}}
spec = importlib.util.spec_from_file_location('oci_identity', Path(__file__).with_name('whisper-candidate-artifact.py'))
oci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oci)


def validate_run(run, jobs, artifacts):
    if (run.get('id'), run.get('head_sha'), run.get('run_attempt'), run.get('status'), run.get('conclusion'), run.get('event'), run.get('path'), run.get('head_repository', {}).get('full_name')) != (
            RUN, HEAD, ATTEMPT, 'completed', 'success', 'pull_request', '.github/workflows/whisper-runtime-candidate.yml', REPOSITORY):
        raise ValueError('Native workflow provenance is not the reviewed successful attempt')
    expected = {'Native runtime amd64', 'Native runtime arm64'}
    native = [job for job in jobs if job.get('name') in expected]
    if len(native) != 2 or {job['name'] for job in native} != expected:
        raise ValueError('Missing or duplicate native jobs')
    for job in native:
        if job.get('status') != 'completed' or job.get('conclusion') != 'success' or job.get('run_attempt') != ATTEMPT:
            raise ValueError('Native job failed, skipped or belongs to another attempt')
        for name in ['Build one native image with loaded and immutable OCI exports', 'Verify native ELF provenance and isolated non-root server health', 'Scan the full exact candidate including unfixed vulnerabilities']:
            steps = [step for step in job.get('steps', []) if step.get('name') == name]
            if len(steps) != 1 or steps[0].get('conclusion') != 'success':
                raise ValueError('Required native gate failed or was skipped')
    for arch, candidate in CANDIDATES.items():
        selected = [artifact for artifact in artifacts if artifact.get('id') == candidate['artifact']]
        if len(selected) != 1:
            raise ValueError('Missing exact reviewed artifact')
        artifact = selected[0]
        if artifact.get('expired') is not False or artifact.get('digest') != candidate['archiveDigest'] or artifact.get('name') != f'whisper-runtime-image-{arch}-{SOURCE}-{ATTEMPT}':
            raise ValueError('Artifact name, archive digest or expiration changed')
    return [{'arch': arch, **candidate} for arch, candidate in CANDIDATES.items()]


def read_file(root, name):
    path = root / name
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()) or path.stat().st_size > 64 * 1024**2:
        raise ValueError('Missing, external or oversized publication evidence')
    return path.read_bytes()


def validate_artifact(directory, arch):
    root = Path(directory)
    candidate = CANDIDATES[arch]
    for name, digest in candidate['evidenceHashes'].items():
        if hashlib.sha256(read_file(root, name)).hexdigest() != digest:
            raise ValueError('Publication evidence differs from reviewed native report')
    if read_file(root, 'source.txt').decode().strip() != SOURCE or read_file(root, 'upstream.txt').decode().strip() != candidate['upstream']:
        raise ValueError('Source or upstream provenance mismatch')
    identity = json.loads(read_file(root, 'identity.json'))
    loaded = {'Id': identity['configDigest'], 'Architecture': arch, 'Os': 'linux', 'RootFS': {'Layers': identity['rootfsDiffIds']}}
    verified = oci.verify(root / 'image', architecture=arch, loaded=loaded)
    if identity != verified or verified['manifestDigest'] != candidate['manifest']:
        raise ValueError('Artifact differs from reviewed OCI manifest')
    config = json.loads((root / 'image/blobs/sha256' / verified['configDigest'][7:]).read_bytes())
    labels = config.get('config', {}).get('Labels', {})
    if labels.get('org.opencontainers.image.revision') != SOURCE or labels.get('io.videoq.whisper.upstream.image') != candidate['upstream']:
        raise ValueError('Image labels differ from reviewed source/upstream')
    runtime = json.loads(read_file(root, 'runtime-receipt.json'))
    if runtime.get('architecture') != arch or runtime.get('candidateConfigDigest') != verified['configDigest'] or runtime.get('upstreamImage') != candidate['upstream'] or runtime.get('nonRootReadOnlyNoEgressServerHealth') is not True or runtime.get('syntheticWavInference') is not True:
        raise ValueError('Runtime smoke does not cover the reviewed artifact')
    if not runtime.get('exactUpstreamElfHashes') or not all(re.fullmatch('[a-f0-9]{64}', digest) for digest in runtime['exactUpstreamElfHashes'].values()):
        raise ValueError('Missing exact ELF provenance')
    syft = json.loads(read_file(root, 'security.json.syft.json'))
    grype = json.loads(read_file(root, 'security.json.grype.json'))
    if syft.get('source', {}).get('metadata', {}).get('imageID') != verified['configDigest'] or grype.get('source', {}).get('target', {}).get('imageID') != verified['configDigest']:
        raise ValueError('Security inventory does not cover the reviewed artifact')
    if grype.get('descriptor', {}).get('db', {}).get('status', {}).get('valid') is not True or grype.get('ignoredMatches'):
        raise ValueError('Security database invalid or findings suppressed')
    if not isinstance(grype.get('matches'), list):
        raise ValueError('Security findings missing')
    if any(match.get('vulnerability', {}).get('severity', 'Unknown').upper() in ['HIGH', 'CRITICAL', 'UNKNOWN'] for match in grype.get('matches', [])):
        raise ValueError('Blocking vulnerability in candidate')
    return {**verified, 'repository': PACKAGE, 'source': SOURCE, 'sourceRun': RUN, 'sourceAttempt': ATTEMPT,
            'artifactId': candidate['artifact'], 'runtimeAndStrictScanBound': True,
            'reference': PACKAGE + '@' + verified['manifestDigest']}


def github(path):
    return json.loads(subprocess.check_output(['gh', 'api', 'repos/' + REPOSITORY + '/' + path], text=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--architecture', choices=['amd64', 'arm64'])
    args = parser.parse_args()
    if args.run:
        run = github(f'actions/runs/{RUN}')
        jobs = github(f'actions/runs/{RUN}/attempts/{ATTEMPT}/jobs?per_page=100')['jobs']
        artifacts = github(f'actions/runs/{RUN}/artifacts?per_page=100')['artifacts']
        print(json.dumps(validate_run(run, jobs, artifacts)))
    elif args.directory and args.architecture:
        print(json.dumps(validate_artifact(args.directory, args.architecture), indent=2))
    else:
        parser.error('Require --run or artifact directory and architecture')
