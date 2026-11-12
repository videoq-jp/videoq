"""One-time host-local secrets. Never print secret material or overwrite live keys."""
import base64
import fcntl
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
from urllib.parse import urlsplit


def generate(url):
    password, access, secret = secrets.token_hex(32), 'GK' + secrets.token_hex(16), secrets.token_hex(32)
    return {
        'videoq-runtime': {
            'DATABASE_URL': f'postgresql://videoq:{password}@postgres:5432/videoq',
            'BETTER_AUTH_SECRET': secrets.token_urlsafe(48),
            'USER_SECRET_ENCRYPTION_KEY': secrets.token_urlsafe(32),
            'R2_ACCESS_KEY_ID': access, 'R2_SECRET_ACCESS_KEY': secret,
            'AWS_ACCESS_KEY_ID': secrets.token_hex(16), 'AWS_SECRET_ACCESS_KEY': secrets.token_hex(32),
            'OPENAI_API_KEY': 'local-inference',
        },
        'videoq-postgres': {'POSTGRES_USER': 'videoq', 'POSTGRES_DB': 'videoq', 'POSTGRES_PASSWORD': password},
        'videoq-garage': {
            'GARAGE_DEFAULT_ACCESS_KEY': access, 'GARAGE_DEFAULT_SECRET_KEY': secret,
            'GARAGE_DEFAULT_BUCKET': 'videoq-media', 'GARAGE_RPC_SECRET': secrets.token_hex(32),
            'GARAGE_ACCESS_KEY_ID': access, 'GARAGE_SECRET_ACCESS_KEY': secret,
            'GARAGE_BUCKET': 'videoq-media', 'GARAGE_CORS_ORIGINS': url,
        },
    }


def kube(*args, data=None):
    result = subprocess.run(['/usr/local/bin/k3s', 'kubectl', '-n', 'videoq', *args],
                            input=json.dumps(data) if data else None, text=True, capture_output=True)
    if result.returncode:
        raise ValueError('Kubernetes credential operation failed; credential values were not logged')
    return json.loads(result.stdout) if result.stdout.strip() else None


def initialize(path, url, run=kube):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError('A plain HTTPS origin is required')
    names = ('videoq-runtime', 'videoq-postgres', 'videoq-garage')
    live = {name: run('get', 'secret', name, '--ignore-not-found', '-o', 'json') for name in names}
    if path.exists():
        if path.is_symlink() or path.stat().st_mode & 0o077:
            raise ValueError('Credential state must be a private regular file')
        state = json.loads(path.read_text())
        if state['url'] != url or set(state['secrets']) != set(names):
            raise ValueError('Existing credentials belong to a different site; migrate explicitly')
    else:
        if any(live.values()):
            raise ValueError('Existing secrets have no matching host backup; import the original credentials before adoption')
        state = {'url': url, 'secrets': generate(url)}
        # Persist before touching Kubernetes, so interruptions can safely resume.
        with open(path, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
            output.write(json.dumps(state))
            output.flush()
            os.fsync(output.fileno())
    # Validate ALL existing keys before writing any missing Secret.
    for name in names:
        expected = state['secrets'][name]
        if not expected or not all(isinstance(k, str) and isinstance(v, str) and v for k, v in expected.items()):
            raise ValueError('Incomplete credential state')
        if live[name]:
            actual = {k: base64.b64decode(v, validate=True).decode() for k, v in live[name].get('data', {}).items()}
            if actual != expected:
                raise ValueError('Live keys differ from the host backup; refusing to overwrite them')
    changed = False
    for name in names:
        if not live[name]:
            run('create', '-f', '-', '-o', 'json', data={
                'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': name},
                'type': 'Opaque', 'stringData': state['secrets'][name],
            })
            changed = True
    return changed


if __name__ == '__main__':
    os.umask(0o077)
    directory = Path('/var/lib/videoq-bootstrap')
    with (directory / 'credentials.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            print('created' if initialize(directory / 'credentials.json', sys.argv[1]) else 'unchanged')
        except (ValueError, OSError, KeyError) as error:
            # Error messages contain policy descriptions only, never raw API data.
            raise SystemExit(str(error))
