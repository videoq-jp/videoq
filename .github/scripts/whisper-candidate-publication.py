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
RUN = 46150445031
HEAD = '5101d2adb949ee2ef1d88faa1c3af13030d957da'
SOURCE = '4646c50a3bbaa2c38838a20997e9c6d403d3c9a0'
ATTEMPT = 1
CANDIDATES = {'amd64': {'artifact': 15265287879,
           'archiveDigest': 'sha256:9e34747b3f89e6951d7529e12930c31b967e9764a53a63a8b4f5bdab6c58ec94',
           'manifest': 'sha256:fdded4d2d5fd197af632738eb8b9d7ffcd621a806173966d4c90abe9e25112c4',
           'upstream': 'ghcr.io/ggml-org/whisper.cpp@sha256:0b39b82d8febd2708a5abd2e3d8d373620604d558922f2cf921b7f4c365e6c73',
           'evidenceHashes': {'identity.json': '8e921dc0a2bb3890cff50135d4306319f42cd0ed24efd17e916bae914482e692',
                              'runtime-receipt.json': '5c94812adb40f6aafbb25da24166098dc541ce7c4f6f1181190731bbf92dcffe',
                              'security.json.syft.json': '0788477145c23853c5dbde03a3f618aa26901f16fae679e8651fe690bb2186d9',
                              'security.json.grype.json': '520f74ec28c5300dd98037b42681fb09a5b53ab34fbf958f61a0481c7001cc0a'}},
 'arm64': {'artifact': 15265746867,
           'archiveDigest': 'sha256:d17b98b4781397e62ac8cbc30d3e07fe664f49ce62eca837565740a94a416324',
           'manifest': 'sha256:c4bc8f62d0e07241b8a5f15d00e111836bae240fd4ee4bd54930b14f0d81a27b',
           'upstream': 'ghcr.io/ggml-org/whisper.cpp@sha256:f0fed3d3d54565cb37d2995fcaa28ca09a5c9f3ffb7fada2d790099af2bfeee0',
           'evidenceHashes': {'identity.json': 'c8e41c3de814e5c202b7265878bc87a191b9331d899e80fb736dec2f8141935c',
                              'runtime-receipt.json': '98e255f5fcd09b11a71ae09fed929863ff71062ed041184c3257ca0365203869',
                              'security.json.syft.json': '785dbeb29f95525282b7809eee97c0312fe7a2cb2c5926a1d275fe4eb8335326',
                              'security.json.grype.json': '5cdd8ab89738ca40b27890596df5fef6d79672c04c379d728e7fbdd2fea44b09'}}}
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
