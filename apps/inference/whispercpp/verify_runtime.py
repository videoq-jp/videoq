"""Verify a loaded exact candidate; never build, publish, prune, or restart Docker."""
from __future__ import annotations
import argparse
import hashlib
import json
import platform
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent
PROVENANCE = json.loads((ROOT / 'provenance.json').read_text())
PROBE_IMAGE = 'python:3.12.16-slim-trixie@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b'
FORBIDDEN_PACKAGES = {'busybox', 'apk-tools', 'linux-headers', 'linux-libc-dev', 'gcc', 'g++', 'build-base', 'binutils', 'make', 'cmake', 'git', 'wget', 'curl', 'ffmpeg'}
FORBIDDEN_FILES = {'bin/sh', 'bin/bash', 'bin/busybox', 'usr/bin/busybox', 'sbin/apk', 'usr/bin/apk', 'usr/bin/gcc', 'usr/bin/g++', 'usr/bin/cc', 'usr/bin/cmake', 'usr/bin/git', 'usr/bin/make', 'usr/bin/wget', 'usr/bin/curl', 'usr/bin/ffmpeg'}

def docker(*args: str, timeout: int = 180) -> str:
    result = subprocess.run(['docker', *args], check=True, text=True, capture_output=True, timeout=timeout)
    return result.stdout.strip()

def inspect(image: str) -> dict:
    rows = json.loads(docker('image', 'inspect', image))
    if len(rows) != 1:
        raise ValueError('Ambiguous image')
    return rows[0]

def package_names(database: str) -> list[str]:
    return sorted(line[2:] for line in database.splitlines() if line.startswith('P:'))

def validate_inventory(names: list[str], packages: list[str]) -> None:
    for raw in names:
        name = str(PurePosixPath(raw.removeprefix('./')))
        if name.startswith('/') or '..' in PurePosixPath(name).parts:
            raise ValueError('Unsafe archive member')
        if name in FORBIDDEN_FILES or name.startswith(('usr/include/', 'usr/local/include/', 'app/ggml/', 'app/src/', 'app/models/')):
            raise ValueError(f'Unexpected development/tool/model file: {name}')
        if name.endswith(('.h', '.hpp', '.a', '.o', '.cpp', '.c')):
            raise ValueError(f'Unexpected development file: {name}')
    if not packages:
        raise ValueError('Runtime package inventory missing')
    for name in packages:
        if name in FORBIDDEN_PACKAGES or name.endswith(('-dev', '-devel', '-headers')):
            raise ValueError(f'Unexpected development/tool package: {name}')

def elf_hashes(directory: Path) -> dict[str, str]:
    result = {}
    for path in sorted(directory.iterdir()):
        if path.name != 'whisper-server' and '.so' not in path.name:
            continue
        if not path.resolve().is_relative_to(directory.resolve()):
            raise ValueError('ELF symlink escaped source directory')
        data = path.read_bytes()
        if not data.startswith(b'\x7fELF'):
            raise ValueError(f'Not ELF: {path.name}')
        result[path.name] = hashlib.sha256(data).hexdigest()
    if 'whisper-server' not in result or len(result) < 2:
        raise ValueError('Server/shared libraries missing')
    return result

HEALTH_PROBE = '''import io,json,time,urllib.request,wave
for attempt in range(360):
 try:
  with urllib.request.urlopen('http://127.0.0.1:8081/health',timeout=2) as response:
   value=json.load(response)
   assert response.status==200 and value.get('status')=='ok'
   break
 except (OSError,AssertionError):time.sleep(.25)
else:raise RuntimeError('whisper-server did not become healthy')
audio=io.BytesIO()
with wave.open(audio,'wb') as wav:
 wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(bytes(32000))
boundary='videoq-synthetic-whisper-smoke'
body=(('--'+boundary+'\\r\\nContent-Disposition: form-data; name="response_format"\\r\\n\\r\\njson\\r\\n--'+boundary+'\\r\\nContent-Disposition: form-data; name="file"; filename="silence.wav"\\r\\nContent-Type: audio/wav\\r\\n\\r\\n').encode()+audio.getvalue()+('\\r\\n--'+boundary+'--\\r\\n').encode())
request=urllib.request.Request('http://127.0.0.1:8081/inference',data=body,headers={'content-type':'multipart/form-data; boundary='+boundary})
with urllib.request.urlopen(request,timeout=90) as response:
 result=json.load(response)
 assert response.status==200 and isinstance(result,dict) and isinstance(result.get('text'),str)
print(json.dumps({'health':True,'synthetic_wav_inference':True}))
'''

def verify(candidate: str, architecture: str, receipt: Path) -> dict:
    native = {'x86_64': 'amd64', 'amd64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}
    if native.get(platform.machine().lower()) != architecture or native.get(docker('info', '--format', '{{.Architecture}}').lower()) != architecture:
        raise ValueError('Native host and Docker architecture must match the requested platform')
    upstream = PROVENANCE['binarySourceImages'][architecture]
    # BuildKit's source cache is not necessarily present in the Docker engine
    # image store used by docker create/cp. Pull this immutable source explicitly.
    docker('pull', '--platform', f'linux/{architecture}', upstream, timeout=300)
    source_info, info = inspect(upstream), inspect(candidate)
    if source_info['Architecture'] != architecture or info['Architecture'] != architecture:
        raise ValueError('Native architecture mismatch')
    if info['Config'].get('Labels', {}).get('io.videoq.whisper.upstream.image') != upstream:
        raise ValueError('Candidate upstream provenance label mismatch')
    if info['Config'].get('User') != '10001:10001':
        raise ValueError('Candidate must run non-root')
    containers = []
    try:
        with tempfile.TemporaryDirectory(prefix='videoq-whisper-runtime-') as temp:
            directory = Path(temp)
            for name, image in [('source', upstream), ('candidate', candidate)]:
                container = docker('create', '--entrypoint', '/app/build/bin/whisper-server', image, '--help')
                containers.append(container)
                docker('cp', f'{container}:/app/build/bin', str(directory / name))
            source_hashes, candidate_hashes = elf_hashes(directory / 'source'), elf_hashes(directory / 'candidate')
            if source_hashes != candidate_hashes:
                raise ValueError('Server/shared ELF bytes differ from approved upstream image')
            allowed = set(candidate_hashes)
            if set(path.name for path in (directory / 'candidate').iterdir()) != allowed:
                raise ValueError('Unexpected executable or artifact copied into final bin directory')
            archive = directory / 'runtime.tar'
            docker('export', '--output', str(archive), containers[1])
            with tarfile.open(archive) as rootfs:
                names = rootfs.getnames()
                database = next((name for name in ['lib/apk/db/installed', 'var/lib/apk/db/installed'] if name in names), None)
                packages = package_names(rootfs.extractfile(database).read().decode()) if database else []
                validate_inventory(names, packages)
                linked = rootfs.extractfile('usr/share/doc/videoq-whispercpp/linked-libraries.txt').read().decode()
                if 'not found' in linked or 'libwhisper' not in linked:
                    raise ValueError('Missing or incomplete dynamic loader dependency receipt')
            result = subprocess.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',candidate,'--help'], capture_output=True, text=True, timeout=30, check=True)
            if '--model' not in result.stdout + result.stderr:
                raise ValueError('Unexpected server help response')
            # Model remains outside the runtime. Use the exact already-bundled
            # upstream model only for the disposable no-egress execution probe.
            model = directory / 'ggml-base.en.bin'
            docker('cp', f'{containers[0]}:/app/models/ggml-base.en.bin', str(model))
            directory.chmod(0o755); model.chmod(0o444)
            docker('pull', PROBE_IMAGE, timeout=300)
            server = 'videoq-whisper-' + uuid.uuid4().hex
            containers.append(server)
            docker('run','--detach','--name',server,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cpus','2','--memory','2g','--mount',f'type=bind,src={model},dst=/models/model.bin,readonly',candidate,'--model','/models/model.bin','--host','127.0.0.1','--port','8081','--no-gpu','--threads','2')
            health = json.loads(docker('run','--rm','--network',f'container:{server}','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','10001:10001','--entrypoint','/usr/local/bin/python',PROBE_IMAGE,'-c',HEALTH_PROBE,timeout=120))
            if health != {'health': True, 'synthetic_wav_inference': True}:
                raise ValueError('Health probe failed')
            result = {'architecture': architecture, 'candidateConfigDigest': info['Id'], 'upstreamImage': upstream,
                      'exactUpstreamElfHashes': candidate_hashes, 'runtimePackages': packages,
                      'linkedLibraries': linked, 'nonRootReadOnlyNoEgressServerHealth': True, 'syntheticWavInference': True,
                      'syntheticProbeModelSha256': hashlib.sha256(model.read_bytes()).hexdigest(),
                      'fullSecurityScanRequiredSeparately': True, 'published': False}
            receipt.write_text(json.dumps(result, indent=2) + '\n')
            return result
    finally:
        for container in reversed(containers):
            subprocess.run(['docker','rm','--force',container], capture_output=True, timeout=30)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--architecture', choices=['amd64', 'arm64'], required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.candidate, args.architecture, args.receipt)))
