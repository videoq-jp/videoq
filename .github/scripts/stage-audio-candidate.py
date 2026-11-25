"""Stage an isolated candidate audio overlay; never edit production wheel locks."""
import argparse
from email.parser import BytesParser
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('locked_audio', ROOT / 'apps/inference/whisper/provision_audio.py')
LOCKED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCKED)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def files(directory):
    result = {}
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError('Symlinks are forbidden in candidate evidence')
        if path.is_file():
            result[str(path.relative_to(directory))] = digest(path)
    return result


def candidate_wheel(candidate):
    wheels = list((candidate / 'wheels').glob('*.whl'))
    if len(wheels) != 1:
        raise ValueError('Exactly one candidate wheel is required')
    wheel = wheels[0]
    match = re.fullmatch(r'av-19\.0\.2-cp312-abi3-([a-z0-9_.]+)\.whl', wheel.name)
    if wheel.is_symlink() or not match:
        raise ValueError('Only the reviewed native CPython 3.12 amd64 PyAV wheel is permitted')
    platforms = match[1].split('.')
    if len(platforms) != len(set(platforms)) or 'manylinux_2_28_x86_64' not in platforms:
        raise ValueError('The reviewed manylinux 2.28 platform is required')
    for platform in platforms:
        version = re.fullmatch(r'manylinux_2_([0-9]+)_x86_64', platform)
        if platform not in {'manylinux1_x86_64', 'manylinux2010_x86_64', 'manylinux2014_x86_64'} and not (
                version and 5 <= int(version[1]) <= 28):
            raise ValueError('Unexpected wheel platform alias')
    if not 0 < wheel.stat().st_size <= 100 * 1024**2:
        raise ValueError('Candidate wheel exceeds the reviewed archive bound')
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or len(names) > 30000:
            raise ValueError('Duplicate or excessive wheel members')
        for name in names:
            if name.split('/')[0] not in {'av', 'av.libs', 'av-19.0.2.dist-info'}:
                raise ValueError('Unexpected candidate wheel member root')
        metadata = BytesParser().parsebytes(archive.read('av-19.0.2.dist-info/WHEEL'))
        if set(metadata.get_all('Tag', [])) != {f'cp312-abi3-{platform}' for platform in platforms}:
            raise ValueError('Wheel metadata tags differ from the filename')
    return wheel


def stage(candidate, lock, cache, output, receipt, download=False):
    if output.exists() or receipt.exists():
        raise ValueError('Candidate output and receipt must be fresh')
    wheel = candidate_wheel(candidate)
    candidate_files = files(candidate)
    for name in ['provenance.json', 'source-lock.json', 'build-smoke.json', 'verify.py', 'ffmpeg-config.log']:
        if name not in candidate_files:
            raise ValueError('Missing candidate provenance or verifier')
    if not any(name.startswith('fixtures/') for name in candidate_files):
        raise ValueError('Missing real codec fixtures')
    manifest = json.loads(lock.read_bytes())
    LOCKED.validate_manifest(manifest)
    av = next(package for package in manifest['packages'] if package['name'] == 'av')
    if av['version'] != '19.0.2':
        raise ValueError('Production PyAV contract changed; review the candidate interface')
    guard = (ROOT / 'apps/inference/whisper/audio_guard.py').read_bytes()
    if hashlib.sha256(guard).hexdigest() != manifest['runtimeGuardSha256']:
        raise ValueError('Trusted guard does not match the reviewed production lock')
    output.mkdir(parents=True)
    try:
        for package in manifest['packages']:
            if package['name'] != 'av':
                source = LOCKED.cached_wheel(package, cache, download)
                LOCKED.extract_wheel(source, package, output)
        # The original PyAV wheel is never extracted, so stale FFmpeg libraries
        # cannot survive alongside the candidate's repaired ELF closure.
        LOCKED.extract_wheel(wheel, av, output)
        (output / 'sitecustomize.py').write_bytes(guard)
        data = {'schemaVersion': 1, 'scope': 'Artifact-only candidate overlay, not a production lock',
                'productionLockSha256': digest(lock), 'wheel': wheel.name,
                'wheelSha256': digest(wheel), 'candidateFiles': candidate_files,
                'overlayFiles': files(output)}
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text(json.dumps(data, indent=2) + '\n')
        return data
    except BaseException:
        shutil.rmtree(output)
        raise


def verify(candidate, output, receipt):
    data = json.loads(receipt.read_text())
    if data['schemaVersion'] != 1 or files(candidate) != data['candidateFiles'] or files(output) != data['overlayFiles']:
        raise ValueError('Built, scanned and smoked candidate bytes changed')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--lock', type=Path, default=ROOT / 'charts/videoq-inference/files/vllm-audio-wheels.json')
    parser.add_argument('--cache', type=Path)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if args.verify:
        verify(args.candidate, args.output, args.receipt)
    else:
        if args.cache is None:
            parser.error('--cache is required when staging')
        stage(args.candidate, args.lock, args.cache, args.output, args.receipt, args.download)
