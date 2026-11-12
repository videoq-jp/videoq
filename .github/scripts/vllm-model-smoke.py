"""Run pinned real models sequentially on one GPU, using the production clients.

For an isolated acceptance machine only. No public ports or model mocking.
Model setup runs separately; serving runs as numeric UID/GID 10001, offline.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid


def run(args):
    profile = json.loads(args.profile.read_text())
    report = {'status': 'running', 'image': profile['image'], 'controllerSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'clientBundleSha256': hashlib.sha256(args.client.read_bytes()).hexdigest(), 'models': {}, 'scope': 'Sequential real inference on one GPU; production model arguments with host bound to loopback. Not a multi-node Kubernetes or capacity test.'}
    def save():
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    base_env = dict(os.environ, HOME='/tmp', PYTHONPATH='/opt/videoq-audio', VLLM_NO_USAGE_STATS='1', DO_NOT_TRACK='1',
                    VLLM_CONFIG_ROOT='/tmp/vllm', VLLM_CACHE_ROOT='/tmp/vllm-cache')
    save()
    for role in args.roles.split(','):
        model = profile['models'][role]
        record = {'repository': model['repository'], 'revision': model['revision'], 'status': 'running'}
        report['models'][role] = record
        started = time.monotonic()
        server = None
        try:
            print(f'[{role}] Provisioning pinned model snapshot', flush=True)
            setup = subprocess.run(['python3', '/tmp/provision.py'], env=dict(base_env,
                MODEL_REPO=model['repository'], MODEL_REVISION=model['revision'], MODEL_FILE='', MODEL_SHA256='',
                MODEL_ROOT='/models', HF_HUB_OFFLINE='0', HOME='/tmp/provision-home',
                HF_HOME='/tmp/provision-hf', XDG_CACHE_HOME='/tmp/provision-cache'), capture_output=True, text=True, timeout=900)
            if setup.returncode:
                raise RuntimeError('Model setup failed: ' + setup.stderr[-5000:])
            directory = Path('/models') / model['revision']
            for path in directory.rglob('*'):
                path.chmod(0o755 if path.is_dir() else 0o644)
            directory.chmod(0o755)
            model_env = dict(base_env, **model.get('env', {}))
            command = ['vllm', 'serve', *model['args']]
            host = command.index('--host')
            command[host + 1] = '127.0.0.1'
            port = command[command.index('--port') + 1]
            logpath = Path('/tmp') / f'{role}-server.log'
            with logpath.open('w') as log:
                server = subprocess.Popen(command, env=dict(model_env, HF_HUB_OFFLINE='1'), stdout=log, stderr=subprocess.STDOUT,
                    user=10001, group=10001, extra_groups=[], start_new_session=True)
            record['command'] = command
            record['runtimeEnv'] = model.get('env', {})
            print(f'[{role}] Starting unchanged upstream engine as UID 10001', flush=True)
            wait_started = time.monotonic()
            progress = wait_started
            while True:
                if server.poll() is not None:
                    raise RuntimeError(f'Engine exited before readiness: {server.returncode}')
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=3) as response:
                        if response.status == 200:
                            break
                except (urllib.error.URLError, TimeoutError):
                    pass
                if time.monotonic() - wait_started > 600:
                    raise TimeoutError('Engine did not become ready in 600 seconds')
                if time.monotonic() - progress >= 30:
                    print(f'[{role}] Waiting for model readiness ({int(time.monotonic() - wait_started)}s)', flush=True)
                    progress = time.monotonic()
                time.sleep(2)
            record['startupSeconds'] = time.monotonic() - wait_started
            print(f'[{role}] Model ready; invoking production contract', flush=True)
            if role in {'embedding', 'chat'}:
                result = subprocess.run([str(args.node), str(args.client), role], env=dict(base_env,
                    OPENAI_API_KEY='local-inference'), capture_output=True, text=True, timeout=600,
                    user=10001, group=10001, extra_groups=[])
                if result.returncode:
                    raise RuntimeError('Production client failed: ' + result.stderr[-6000:] + result.stdout[-1000:])
                record['client'] = json.loads(result.stdout.strip().splitlines()[-1])
            else:
                checksum = hashlib.sha256(args.fixture.read_bytes()).hexdigest()
                if checksum != '383c9ab832a5d546bebec1552a0c4e3d49bfd2155b468fa62c08d892a44553d4':
                    raise ValueError('Unexpected public Japanese FLEURS fixture')
                convert = 'import soundfile,soxr; x,sr=soundfile.read("/tmp/fleurs-ja-00.mp3"); soundfile.write("/tmp/fleurs-ja.wav",soxr.resample(x,sr,16000),16000,format="WAV")'
                subprocess.run(['python3', '-c', convert], env=base_env, user=10001, group=10001, extra_groups=[], check=True)
                boundary = uuid.uuid4().hex
                body = bytearray()
                for key, value in {'model': 'whisper-local', 'response_format': 'verbose_json', 'timestamp_granularities[]': 'segment', 'language': 'ja'}.items():
                    body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
                body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode())
                body.extend(Path('/tmp/fleurs-ja.wav').read_bytes())
                body.extend(f'\r\n--{boundary}--\r\n'.encode())
                request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/audio/transcriptions', data=bytes(body), headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
                with urllib.request.urlopen(request, timeout=180) as response:
                    result = json.load(response)
                if 'インターネット' not in result.get('text', '') or not result.get('segments'):
                    raise ValueError('Whisper did not return the expected Japanese transcript and segments')
                record['client'] = {'status': 'passed', 'fixtureSha256': checksum, 'transcript': result}
            record['status'] = 'passed'
            print(f'[{role}] Passed', flush=True)
        except Exception as error:
            record.update(status='failed', errorType=type(error).__name__, error=str(error))
            log = Path('/tmp') / f'{role}-server.log'
            if log.exists():
                record['serverLogTail'] = log.read_text(errors='replace')[-14000:]
            print(f'[{role}] Failed: {error}', flush=True)
        finally:
            if server:
                try:
                    os.killpg(server.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    server.wait(timeout=45)
                except subprocess.TimeoutExpired:
                    os.killpg(server.pid, signal.SIGKILL)
                    server.wait(timeout=10)
            record['elapsedSeconds'] = time.monotonic() - started
            save()
            time.sleep(3)
    report['status'] = 'passed' if all(model['status'] == 'passed' for model in report['models'].values()) else 'failed'
    save()
    return report['status'] == 'passed'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--client', type=Path, required=True)
    parser.add_argument('--fixture', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--roles', default='embedding,whisper,chat')
    sys.exit(0 if run(parser.parse_args()) else 1)
