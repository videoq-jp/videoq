"""Configure DNS only on disposable GitHub-hosted on-prem CI runners."""
import argparse
import json
import os
import re
import socket
import subprocess

RESOLVERS = ('1.1.1.1', '8.8.8.8')
HOSTS = ('archive.ubuntu.com', 'security.ubuntu.com', 'ghcr.io')
DOCKER_CONFIG = '''import json, os, stat, tempfile
from pathlib import Path
path = Path('/etc/docker/daemon.json')
old = path.stat() if path.exists() else None
config = json.loads(path.read_text()) if old else {}
if not isinstance(config, dict):
    raise ValueError('Docker daemon configuration must be an object')
config['dns'] = ['1.1.1.1', '8.8.8.8']
path.parent.mkdir(parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
    temporary = Path(stream.name)
    try:
        json.dump(config, stream, indent=2)
        stream.write('\\n')
        stream.close()
        os.chmod(temporary, stat.S_IMODE(old.st_mode) if old else 0o644)
        if old:
            os.chown(temporary, old.st_uid, old.st_gid)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
'''


def run(command, **kwargs):
    return subprocess.run(command, text=True, capture_output=True, **kwargs)


def configure(*, docker=False, environment=None, execute=run, resolve=socket.getaddrinfo):
    environment = os.environ if environment is None else environment
    if environment.get('GITHUB_ACTIONS') != 'true' or environment.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise ValueError('DNS setup is restricted to disposable GitHub-hosted CI runners')
    if docker and execute(['docker', 'ps', '-q'], check=True).stdout.strip():
        raise ValueError('Refusing to restart Docker with active service containers')
    routes = json.loads(execute(['ip', '-json', 'route', 'show', 'default'], check=True).stdout)
    routes = sorted((r for r in routes if r.get('dev')), key=lambda r: r.get('metric', 0))
    interface = routes[0]['dev'] if routes else ''
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]*', interface):
        raise ValueError('No unambiguous default network interface')
    execute(['sudo', '-n', 'resolvectl', 'dns', interface, *RESOLVERS], check=True)
    execute(['sudo', '-n', 'resolvectl', 'domain', interface, '~.'], check=True)
    execute(['sudo', '-n', 'resolvectl', 'flush-caches'], check=True)
    for host in HOSTS:
        if not resolve(host, 443, type=socket.SOCK_STREAM):
            raise ValueError('Public repository DNS validation failed: ' + host)
    if docker:
        execute(['sudo', '-n', 'python3', '-c', DOCKER_CONFIG], check=True)
        execute(['sudo', '-n', 'systemctl', 'restart', 'docker'], check=True)
        execute(['docker', 'info'], check=True)
    print('Configured CI DNS: ' + ', '.join(RESOLVERS) + ('; Docker DNS updated' if docker else '; existing service containers retained'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--docker', action='store_true', help='Also configure/restart Docker; refuses active containers')
    args = parser.parse_args()
    configure(docker=args.docker)
