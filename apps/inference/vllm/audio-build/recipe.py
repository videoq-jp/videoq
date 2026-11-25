"""Prepare a standalone, hash-locked, offline candidate Docker build context."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent


def lock():
    return json.loads((ROOT / 'source-lock.json').read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_file(path, item):
    if Path(path).stat().st_size != item['size'] or digest(path) != item['sha256']:
        raise ValueError(f"Locked input mismatch: {item['filename']}")


def verify_inputs(directory, signature=True):
    data = lock()
    for item in data['sources'] + data['buildTools']:
        verify_file(Path(directory) / item['filename'], item)
    if signature:
        with tempfile.TemporaryDirectory() as home:
            subprocess.run(['gpg', '--batch', '--homedir', home, '--import',
                            str(Path(directory) / 'ffmpeg-devel.asc')], check=True, capture_output=True)
            result = subprocess.run(['gpg', '--batch', '--homedir', home, '--status-fd', '1', '--verify',
                                     str(Path(directory) / 'ffmpeg-9.1.tar.xz.asc'),
                                     str(Path(directory) / 'ffmpeg-9.1.tar.xz')],
                                    check=True, capture_output=True, text=True)
            valid = '[GNUPG:] VALIDSIG ' + data['ffmpegSigningFingerprint'] + ' '
            if not any(line.startswith(valid) for line in result.stdout.splitlines()):
                raise ValueError('Unexpected FFmpeg release signer')
    # Signed release source hashes and exact upstream additions, not only the
    # version string: each of the eleven fixes must be in this archive.
    with tarfile.open(Path(directory) / 'ffmpeg-9.1.tar.xz') as archive:
        for fix in data['fixes']:
            for source in fix['releaseFiles']:
                content = archive.extractfile('ffmpeg-9.1/' + source['path']).read()
                if hashlib.sha256(content).hexdigest() != source['sha256']:
                    raise ValueError(f"Release fix file changed: {fix['cve']}")
                if not all(line in content.decode() for line in source['fixAddedLines']):
                    raise ValueError(f"Missing upstream fix: {fix['cve']}")
    return {'signatureFingerprint': data['ffmpegSigningFingerprint'] if signature else None,
            'fixesVerified': len(data['fixes']), 'allInputHashesVerified': True}


def extract_regular(archive_path, destination):
    """Copy only validated regular members using pinned directory descriptors.

    Never delegate archive paths, links, ownership or modes to tarfile's write
    APIs. O_EXCL/O_NOFOLLOW prevent replacement and symlink following even if a
    path is injected after validation. Archive executable bits are needed by
    configure; privileged/write-for-others bits and ownership are never restored.
    """
    destination = Path(destination).absolute()
    destination.mkdir(parents=True, mode=0o700, exist_ok=False)
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    with tarfile.open(archive_path) as archive:
        members = []
        names = {}
        for member in archive.getmembers():
            name = member.name[:-1] if member.isdir() and member.name.endswith('/') else member.name
            parts = name.split('/')
            if (not name or '\\' in name or '\0' in name or
                    any(part in ('', '.', '..') for part in parts) or
                    member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) or
                    member.sparse is not None or name in names):
                raise ValueError('Archive contains an unsafe path, duplicate or nonregular member')
            names[name] = member.isdir()
            members.append((member, parts))
        for _, parts in members:
            if any(names.get('/'.join(parts[:i])) is False for i in range(1, len(parts))):
                raise ValueError('Archive file conflicts with a parent directory')
        root_fd = os.open(destination, directory_flags)
        try:
            for member, parts in members:
                parent_fd = os.dup(root_fd)
                try:
                    for component in parts[:-1]:
                        try:
                            os.mkdir(component, mode=0o700, dir_fd=parent_fd)
                        except FileExistsError:
                            pass
                        child_fd = os.open(component, directory_flags, dir_fd=parent_fd)
                        os.close(parent_fd)
                        parent_fd = child_fd
                    if member.isdir():
                        try:
                            os.mkdir(parts[-1], mode=0o700, dir_fd=parent_fd)
                        except FileExistsError:
                            # Validate an existing implicit parent without following links.
                            existing_fd = os.open(parts[-1], directory_flags, dir_fd=parent_fd)
                            os.close(existing_fd)
                    else:
                        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                        fd = os.open(parts[-1], flags, 0o600, dir_fd=parent_fd)
                        with os.fdopen(fd, 'wb') as output, archive.extractfile(member) as source:
                            shutil.copyfileobj(source, output, length=1024 * 1024)
                            # Owner-only permissions; preserve only whether owner may execute.
                            os.fchmod(output.fileno(), 0o700 if member.mode & 0o100 else 0o600)
                finally:
                    os.close(parent_fd)
        finally:
            os.close(root_fd)


def prepare(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    inputs = directory / 'inputs'
    inputs.mkdir()
    for item in lock()['sources'] + lock()['buildTools']:
        # URLs and sizes are repository-reviewed immutable lock inputs.
        with urllib.request.urlopen(item['url'], timeout=60) as response:
            content = response.read(item['size'] + 1)
        path = inputs / item['filename']
        with path.open('xb') as output:
            output.write(content)
        verify_file(path, item)
    result = verify_inputs(inputs)
    recipe = directory / 'recipe'
    recipe.mkdir()
    for path in ROOT.iterdir():
        if path.is_file() and not path.name.startswith('test_'):
            shutil.copyfile(path, recipe / path.name)
    shutil.copyfile(ROOT / 'Dockerfile', directory / 'Dockerfile')
    (recipe / 'source-verification.json').write_text(json.dumps(result, indent=2) + '\n')


def provenance(output):
    output = Path(output)
    wheels = list((output / 'wheels').glob('*.whl'))
    if len(wheels) != 1:
        raise ValueError('Expected exactly one repaired candidate wheel')
    wheel = wheels[0]
    with zipfile.ZipFile(wheel) as archive:
        members = {name: hashlib.sha256(archive.read(name)).hexdigest()
                   for name in archive.namelist() if not name.endswith('/')}
    result = {'status': 'candidate-requires-independent-native-and-security-gates',
              'sourceLock': lock(), 'sourceLockSha256': digest(ROOT / 'source-lock.json'),
              'recipeHashes': {p.name: digest(p) for p in ROOT.iterdir() if p.is_file()},
              'wheel': {'filename': wheel.name, 'sha256': digest(wheel), 'size': wheel.stat().st_size,
                        'members': members},
              'toolchain': {cmd[0]: subprocess.check_output(cmd, text=True).splitlines()[0]
                            for cmd in (['gcc', '--version'], ['ld', '--version'], ['make', '--version'],
                                        ['patchelf', '--version'], [lock()['python'], '--version'])}}
    (output / 'provenance.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('prepare').add_argument('--directory', required=True)
    sub.add_parser('verify-inputs').add_argument('--directory', required=True)
    sub.add_parser('verify-archives').add_argument('--directory', required=True)
    ext = sub.add_parser('extract')
    ext.add_argument('--archive', required=True)
    ext.add_argument('--destination', required=True)
    sub.add_parser('provenance').add_argument('--output', required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.directory)
    elif args.command == 'verify-inputs':
        print(json.dumps(verify_inputs(args.directory)))
    elif args.command == 'verify-archives':
        print(json.dumps(verify_inputs(args.directory, signature=False)))
    elif args.command == 'extract':
        extract_regular(args.archive, args.destination)
    else:
        provenance(args.output)
