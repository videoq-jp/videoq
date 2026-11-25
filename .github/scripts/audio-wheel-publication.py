"""Publish only reviewed tested bytes to one fixed release; never execute artifact code."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request
import zipfile

REPOSITORY = 'videoq-jp/videoq'
PUBLISHER_TAG = 'videoq-audio-wheel-publisher-20261126-v1'
RELEASE_TAG = 'videoq-audio-wheel-20261126-v1'
ASSET = 'av-19.0.2-cp312-abi3-manylinux_2_28_x86_64.whl'
POLICY = Path(__file__).with_suffix('.json')
EVIDENCE = {'audio-evidence/source.json', 'audio-evidence/identity.json',
            'audio-evidence/security.json.grype.json', 'audio-evidence/security.json.syft.json',
            'audio-native/native-smoke.json', 'audio-candidate/provenance.json',
            'audio-candidate/source-lock.json', 'audio-candidate/build-smoke.json'}
GATES = ['Verify signed and hash-locked official build inputs',
         'Build native Python 3.12 wheel and genuine FFmpeg offline',
         'Stage isolated candidate with unchanged locked companion wheels and guard',
         'Scan every installed candidate package and ELF without suppressions',
         'Exercise exact candidate codecs and real vLLM preprocessing without model weights',
         'Require built, scanned and smoked bytes to remain identical']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def approved(policy):
    if (policy.get('status'), policy.get('repository'), policy.get('publisherTag'),
            policy.get('releaseTag'), policy.get('asset')) != (
            'reviewed-corrected-native-proof', REPOSITORY, PUBLISHER_TAG, RELEASE_TAG, ASSET):
        raise ValueError('Publication is disabled pending independently reviewed corrected native proof')
    for key in ['run', 'attempt', 'artifact', 'wheelSize']:
        if type(policy.get(key)) is not int or policy[key] <= 0:
            raise ValueError('Missing exact positive publication pin: ' + key)
    for key, length in [('head', 40), ('source', 40), ('archiveSha256', 64), ('wheelSha256', 64)]:
        if not re.fullmatch('[a-f0-9]{' + str(length) + '}', str(policy.get(key))):
            raise ValueError('Invalid immutable publication pin: ' + key)
    if set(policy.get('evidenceHashes', {})) != EVIDENCE or any(
            not re.fullmatch('[a-f0-9]{64}', str(value)) for value in policy['evidenceHashes'].values()):
        raise ValueError('Complete independently reviewed evidence hashes are required')


def validate_run(policy, run, jobs, artifacts):
    approved(policy)
    if (run.get('id'), run.get('head_sha'), run.get('run_attempt'), run.get('status'),
            run.get('conclusion'), run.get('event'), run.get('path'),
            run.get('head_repository', {}).get('full_name')) != (
            policy['run'], policy['head'], policy['attempt'], 'completed', 'success',
            'pull_request', '.github/workflows/patched-audio-candidate.yml', REPOSITORY):
        raise ValueError('Not the exact reviewed successful native workflow attempt')
    native = [job for job in jobs if job.get('name') == 'native-source']
    if len(native) != 1 or (native[0].get('status'), native[0].get('conclusion'),
                            native[0].get('run_attempt')) != ('completed', 'success', policy['attempt']):
        raise ValueError('Missing, failed, skipped or wrong-attempt native job')
    for name in GATES:
        steps = [step for step in native[0].get('steps', []) if step.get('name') == name]
        if len(steps) != 1 or steps[0].get('conclusion') != 'success':
            raise ValueError('Required native gate did not succeed: ' + name)
    selected = [artifact for artifact in artifacts if artifact.get('id') == policy['artifact']]
    if len(selected) != 1 or (selected[0].get('name'), selected[0].get('digest'),
                              selected[0].get('expired')) != (
            f"patched-audio-candidate-{policy['source']}-{policy['attempt']}",
            'sha256:' + policy['archiveSha256'], False):
        raise ValueError('Exact unexpired artifact identity is required')


def gh_api(path):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{REPOSITORY}/' + path], text=True))


def authorize_remote(policy):
    approved(policy)
    run = policy['run']
    validate_run(policy, gh_api(f'actions/runs/{run}'),
                 gh_api(f'actions/runs/{run}/attempts/{policy["attempt"]}/jobs?per_page=100')['jobs'],
                 gh_api(f'actions/runs/{run}/artifacts?per_page=100')['artifacts'])


def artifact_bytes(policy, archive):
    approved(policy)
    if archive.is_symlink() or archive.stat().st_size > 128 * 1024**2:
        raise ValueError('Invalid bounded artifact archive')
    if sha(archive.read_bytes()) != policy['archiveSha256']:
        raise ValueError('Artifact ZIP differs from the reviewed exact bytes')
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        names = [entry.filename for entry in entries]
        if len(entries) > 30000 or len(set(names)) != len(names) or sum(
                entry.file_size for entry in entries) > 512 * 1024**2:
            raise ValueError('Duplicate or oversized archive')
        for entry in entries:
            path = Path(entry.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or (
                    entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Unsafe artifact entry')
        for name, digest in policy['evidenceHashes'].items():
            if sha(bundle.read(name)) != digest:
                raise ValueError('Reviewed evidence changed: ' + name)
        source = json.loads(bundle.read('audio-evidence/source.json'))
        if (source.get('source'), source.get('run'), source.get('attempt'), source.get('architecture')) != (
                policy['source'], str(policy['run']), str(policy['attempt']), 'x86_64'):
            raise ValueError('Evidence source/run/architecture mismatch')
        native = json.loads(bundle.read('audio-native/native-smoke.json'))
        if (native.get('status'), native.get('ffmpegVersion'), native.get('pyavVersion')) != (
                'passed', '9.1', '19.0.2') or len(native.get('whisperPreprocessing', [])) != 4:
            raise ValueError('Missing independently reviewed actual serving proof')
        grype = json.loads(bundle.read('audio-evidence/security.json.grype.json'))
        if grype.get('ignoredMatches') or grype.get('matches') or grype.get(
                'descriptor', {}).get('db', {}).get('status', {}).get('valid') is not True:
            raise ValueError('Full scan is not the reviewed valid zero-finding unsuppressed result')
        wheel = bundle.read('audio-candidate/wheels/' + ASSET)
        provenance = json.loads(bundle.read('audio-candidate/provenance.json'))
        if len(wheel) != policy['wheelSize'] or sha(wheel) != policy['wheelSha256'] or (
                provenance['wheel']['sha256'], provenance['wheel']['filename']) != (policy['wheelSha256'], ASSET):
            raise ValueError('Wheel does not equal tested reviewed bytes')
        validate_members_and_native(wheel, provenance, native,
                                    json.loads(bundle.read('audio-evidence/identity.json')))
        return wheel


def validate_members_and_native(wheel, provenance, native, identity):
    members = provenance['wheel']['members']
    with zipfile.ZipFile(io.BytesIO(wheel)) as archive:
        all_entries = archive.infolist()
        entries = [entry for entry in all_entries if not entry.is_dir()]
        if len(all_entries) > 30000 or len(entries) != len(members) or len(
                {entry.filename for entry in all_entries}) != len(all_entries):
            raise ValueError('Wheel member identity differs from reviewed provenance')
        for entry in all_entries:
            path = Path(entry.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or (
                    entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Unsafe wheel member')
        if sum(entry.file_size for entry in entries) > 512 * 1024**2:
            raise ValueError('Oversized wheel members')
        for entry in entries:
            if sha(archive.read(entry)) != members.get(entry.filename):
                raise ValueError('Wheel member digest mismatch')
    installed = {name: digest for name, digest in members.items() if name.startswith(('av/', 'av.libs/'))}
    if not installed or any(identity['overlayFiles'].get(name) != digest for name, digest in installed.items()):
        raise ValueError('Scanned installed member identity differs from exact wheel')
    exact = {'installedMemberCount': len(installed),
             'compiledFilters': ['abuffer', 'abuffersink', 'aformat', 'aresample', 'buffer', 'buffersink'],
             'compiledDecoders': ['flac', 'mp3', 'mp3float', 'pcm_s16le'],
             'compiledEncoders': [], 'nativeMuxers': [],
             'nativeProtocols': {'0': ['file', 'pipe'], '1': ['file', 'pipe']}}
    if any(native.get(key) != value for key, value in exact.items()):
        raise ValueError('Native capability identity mismatch')
    loaded = sorted('/opt/videoq-audio/' + name for name in installed
                    if name.startswith('av.libs/') and '.so' in name)
    if not loaded or native.get('loadedCandidateElfs') != loaded:
        raise ValueError('Exact loaded native ELF closure mismatch')
    fixtures = ['pcm16-16k-mono', 'pcm16-48k-stereo', 'extra_overread.mp3', 'luckynight.flac']
    for key, count in [('decodeResample', 'samples16kMono'), ('whisperPreprocessing', 'samples')]:
        rows = native.get(key, [])
        if [row.get('fixture') for row in rows] != fixtures or any(
                type(row.get(count)) is not int or row[count] <= 0 for row in rows):
            raise ValueError('Missing bounded actual decode/serving fixture evidence')
    for row in native['whisperPreprocessing']:
        if not isinstance(row.get('duration'), (int, float)) or not 0 < row['duration'] <= 180:
            raise ValueError('Invalid actual serving duration')
        if row['fixture'].startswith('pcm16-') and (row['samples'], row['duration']) != (1600, 0.1):
            raise ValueError('PCM full-duration automatic serving fallback was not preserved')
    # MP3 PyAV and serving decoders apply different trimming: compare each to its
    # reviewed receipt, never assume 160079 decoded == 159887 serving samples.


def require_absent(path):
    url = 'https://api.github.com/repos/' + REPOSITORY + '/' + path
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json'}), timeout=30):
            pass
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return
        raise
    raise ValueError('Immutable publication scope already exists; never replace it')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['validate', 'publish', 'readback'])
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--revision', required=True)
    args = parser.parse_args()
    policy = json.loads(POLICY.read_text())
    approved(policy)
    if not re.fullmatch('[a-f0-9]{40}', args.revision):
        raise ValueError('Exact reviewed publisher revision required')
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    if actual != args.revision:
        raise ValueError('Local publisher checkout differs from exact reviewed revision')
    # Read-only prospective validation works before any tag exists. Every write
    # still requires the uniquely reviewed immutable publisher tag.
    if args.mode != 'validate':
        tag = gh_api('git/ref/tags/' + PUBLISHER_TAG)
        if tag.get('object') != {'sha': args.revision, 'type': 'commit',
                                  'url': f'https://api.github.com/repos/{REPOSITORY}/git/commits/{args.revision}'}:
            raise ValueError('Reviewed immutable publisher tag mismatch')
    if args.mode == 'readback':
        url = f'https://github.com/{REPOSITORY}/releases/download/{RELEASE_TAG}/{ASSET}'
        # urllib sends no GitHub token: this proves anonymous consumer access.
        with urllib.request.urlopen(url, timeout=60) as response:
            wheel = response.read(policy['wheelSize'] + 1)
        if len(wheel) != policy['wheelSize'] or sha(wheel) != policy['wheelSha256']:
            raise ValueError('Anonymous released bytes mismatch')
        print(json.dumps({'url': url, 'sha256': sha(wheel), 'size': len(wheel), 'anonymous': True}))
        return
    authorize_remote(policy)
    wheel = artifact_bytes(policy, args.archive)
    require_absent('git/ref/tags/' + RELEASE_TAG)
    require_absent('releases/tags/' + RELEASE_TAG)
    if args.mode == 'publish':
        # Only trusted source executes; artifact content is opaque upload data.
        path = Path(ASSET)
        with path.open('xb') as output:
            output.write(wheel)
        subprocess.run(['gh', 'release', 'create', RELEASE_TAG, str(path), '--repo', REPOSITORY,
                        '--target', args.revision, '--title', 'Reviewed native audio wheel',
                        '--notes', 'Exact independently verified FFmpeg 9.1 / PyAV 19.0.2 wheel; no rebuild.'], check=True)
    print(json.dumps({'tag': RELEASE_TAG, 'asset': ASSET, 'sha256': sha(wheel), 'size': len(wheel)}))


if __name__ == '__main__':
    main()
