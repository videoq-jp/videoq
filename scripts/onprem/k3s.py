#!/usr/bin/env python3
"""Install, update or uninstall VideoQ on one VPS using k3d-managed K3s."""
import argparse
import base64
import errno
import getpass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import image_refs, origin, private_json, json_documents
from local_ai import LocalAI
from lifecycle import Lifecycle

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / 'charts/videoq/examples/single-node'
REPOSITORY = 'videoq-jp/videoq'
K3S = 'rancher/k3s@sha256:ca7f37d993d82ef0dcdcfecb2e0e2618ea541dbaffc620c8cedebe01a82acd0d'


def public_origin(value):
    result = origin(value)
    parsed = urlsplit(result)
    if parsed.scheme != 'https' or parsed.port not in (None, 443):
        raise ValueError('公開 URL は https://ホスト名 または https://公開IPv4（443番）を指定してください')
    host = parsed.hostname
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if ('.' not in host or host.endswith(('.localhost', '.local', '.internal'))
                or len(host) > 253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', p) for p in host.split('.'))):
            raise ValueError('公開 DNS 名または公開 IPv4 を指定してください')
    else:
        if address.version != 4 or not address.is_global:
            raise ValueError('IP で公開する場合はグローバル IPv4 を指定してください')
    return result


def caddyfile(url):
    host = urlsplit(public_origin(url)).hostname
    return f'''{{
    default_sni {host}
    auto_https disable_redirects
    servers {{
        protocols h1 h2
    }}
}}
{url} {{
    tls {{
        issuer acme https://acme-v02.api.letsencrypt.org/directory {{
            profile shortlived
            disable_http_challenge
        }}
    }}
    @storage path /videoq-media /videoq-media/*
    handle @storage {{
        header {{
            Content-Security-Policy "sandbox; default-src 'none'"
            X-Content-Type-Options nosniff
        }}
        reverse_proxy garage:3900
    }}
    @api path /api /api/* /.well-known/* /health /ready
    handle @api {{
        reverse_proxy videoq-api:8787 {{
            flush_interval -1
        }}
    }}
    handle {{
        reverse_proxy videoq-web:80
    }}
}}
http://:8081 {{
    respond /healthz 200
}}
'''




def infrastructure(items, config):
    # Changing a mounted configuration must restart its Pod (subPath mounts do not update live).
    items = json.loads(json.dumps(items))
    for item in items:
        name, kind = item['metadata']['name'], item['kind']
        if kind == 'Deployment' and name in ('garage', 'queue', 'videoq-gateway'):
            key = {'garage': 'garage.toml', 'queue': 'elasticmq.conf', 'videoq-gateway': 'Caddyfile'}[name]
            template = item['spec']['template']
            template['metadata'].setdefault('annotations', {})['videoq.jp/config-hash'] = hashlib.sha256(config[key].encode()).hexdigest()
    return items


def site_values(url):
    return {'fullnameOverride': 'videoq', 'publicUrl': url, 'existingSecret': 'videoq-runtime', 'requireImageDigests': True,
            'api': {'replicas': 1, 'trustedProxyHops': 1, 'databasePoolMax': 4, 'rateLimitPoolMax': 2,
                    'resources': {'requests': {'cpu': '100m', 'memory': '128Mi'}, 'limits': {'memory': '512Mi'}}},
            'worker': {'replicas': 1, 'resources': {'requests': {'cpu': '250m', 'memory': '256Mi'},
                                                 'limits': {'cpu': '1', 'memory': '1536Mi'}}},
            'storage': {'endpoint': url, 'internalEndpoint': 'http://garage:3900', 'bucket': 'videoq-media', 'region': 'garage'},
            'queue': {'url': 'http://queue:9324/000000000000/videoq-jobs', 'region': 'us-east-1'}, 'ingress': {'enabled': False}}


def new_credentials(key, url, ai='openrouter'):
    if not key.strip() or any(c in key for c in '\r\n\x00'):
        raise ValueError('空でない1行の OpenRouter API キーを指定してください')
    password, access, secret = secrets.token_hex(32), 'GK' + secrets.token_hex(16), secrets.token_hex(32)
    values = {'videoq-runtime': {'DATABASE_URL': 'postgresql://videoq:' + password + '@postgres:5432/videoq',
                              'BETTER_AUTH_SECRET': secrets.token_urlsafe(48), 'USER_SECRET_ENCRYPTION_KEY': secrets.token_urlsafe(32),
                              'R2_ACCESS_KEY_ID': access, 'R2_SECRET_ACCESS_KEY': secret,
                              'AWS_ACCESS_KEY_ID': secrets.token_hex(16), 'AWS_SECRET_ACCESS_KEY': secrets.token_hex(32), 'OPENROUTER_API_KEY': key},
            'videoq-postgres': {'POSTGRES_USER': 'videoq', 'POSTGRES_DB': 'videoq', 'POSTGRES_PASSWORD': password},
            'videoq-garage': {'GARAGE_DEFAULT_ACCESS_KEY': access, 'GARAGE_DEFAULT_SECRET_KEY': secret,
                             'GARAGE_DEFAULT_BUCKET': 'videoq-media', 'GARAGE_RPC_SECRET': secrets.token_hex(32),
                             'GARAGE_ACCESS_KEY_ID': access, 'GARAGE_SECRET_ACCESS_KEY': secret,
                             'GARAGE_BUCKET': 'videoq-media', 'GARAGE_CORS_ORIGINS': url}}
    if ai != 'openrouter':
        values['videoq-runtime'].pop('OPENROUTER_API_KEY')
        values['videoq-runtime']['OPENAI_API_KEY'] = (os.getenv('VIDEOQ_LOCAL_AI_KEY') or 'local-inference')
    return values




class Installer(Lifecycle, LocalAI):
    def __init__(self, args):
        self.args = args
        self.directory = Path(args.directory).expanduser().resolve()
        command = getattr(args, 'command', 'install')
        if command != 'install' and not (self.directory / 'installation.json').is_file():
            raise ValueError('導入記録がありません。--directory を確認してください')
        if command == 'install':
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(self.directory, 0o700)
        self.state_path = self.directory / 'installation.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.ai = getattr(args, 'ai', None) or self.state.get('ai', 'openrouter')
        if self.state and self.ai != self.state.get('ai', 'openrouter'):
            raise ValueError('既存データの AI プロファイルは変更できません。埋め込みの再索引を計画するか、新しい導入先を使用してください')
        self.url = public_origin(args.url or self.state.get('url') or input('公開 HTTPS URL（https://公開IPv4 またはドメイン）: ').strip())
        self.cluster = args.cluster or self.state.get('cluster', 'videoq-vps')
        if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?', self.cluster):
            raise ValueError('クラスタ名は40文字以内の英小文字・数字・ハイフンで指定してください')
        if self.state and (self.state['url'] != self.url or self.state['cluster'] != self.cluster):
            raise ValueError('再開時は同じ URL とクラスタを指定してください。変更には移行計画が必要です')
        if command == 'install' and self.state.get('run_id') and args.run_id and str(args.run_id) != str(self.state['run_id']):
            raise ValueError('再開時に別のリリースへ切り替えられません。更新はバックアップ後に計画してください')
        if command == 'install' and self.state.get('source_sha') and args.source_sha and args.source_sha != self.state['source_sha']:
            raise ValueError('再開時は記録済みのソース SHA を使用してください')
        tools = Path(os.environ.get('VIDEOQ_TOOLS_DIR', str(Path.home() / '.local/bin')))
        os.environ['PATH'] = str(tools) + os.pathsep + os.environ['PATH']
        self.kubeconfig = self.directory / 'kubeconfig'
        os.environ['KUBECONFIG'] = str(self.kubeconfig)
        self.docker_prefix = []

    def run(self, *command, capture=False, data=None):
        return subprocess.run(list(command), input=data, text=True, check=True,
                              stdout=subprocess.PIPE if capture else None).stdout

    def kube(self, *command, **kwargs):
        return self.run('kubectl', '--kubeconfig', str(self.kubeconfig), '-n', 'videoq', *command, **kwargs)

    def apply(self, obj):
        return self.kube('apply', '-f', '-', data=json.dumps(obj))

    def stage(self, message):
        print('\n' + message, flush=True)

    def tools(self, auth=True):
        names = ('k3d', 'kubectl', 'helm', 'gh') if auth else ('k3d', 'kubectl', 'helm')
        installed = all(shutil.which(name) for name in names)
        if installed and auth:
            probe = subprocess.run(['gh', 'attestation', 'verify', '--help'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            installed = probe.returncode == 0
        if not installed:
            if not auth:
                raise ValueError('操作用ツールが不足しています。install-tools.sh を実行してください')
            self.run('bash', str(ROOT / 'scripts/onprem/install-tools.sh'))
        if auth:
            authenticated = subprocess.run(['gh', 'auth', 'status'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if authenticated.returncode:
                self.run('gh', 'auth', 'login')
        result = subprocess.run(['docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            probe = subprocess.run(['sudo', '-n', 'docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if probe.returncode:
                self.run('sudo', '-v')
                self.run('sudo', '-n', 'docker', 'info', capture=True)
            self.docker_prefix = ['sudo', '-n']

    def k3d(self, *args, **kwargs):
        return self.run(*self.docker_prefix, shutil.which('k3d'), *args, **kwargs)

    def release(self, updating=False):
        self.stage('1/6 リリースを取得し、署名を検証します')
        selection = self.state.get('pending_update', {}).get('target', {}) if updating else self.state
        if updating and selection:
            if self.args.run_id and str(self.args.run_id) != str(selection['run_id']):
                raise ValueError('未完了の更新は記録したリリースで再開してください')
            if self.args.source_sha and self.args.source_sha != selection['source_sha']:
                raise ValueError('未完了の更新は記録したソース SHA で再開してください')
        run_id = self.args.run_id or selection.get('run_id')
        if not run_id:
            runs = json.loads(self.run('gh', 'run', 'list', '--repo', REPOSITORY, '--workflow', 'onprem-release.yml',
                                      '--status', 'success', '--limit', '1', '--json', 'databaseId,headSha,url', capture=True))
            if not runs:
                raise ValueError('成功した On-prem Release がありません')
            run_id = runs[0]['databaseId']
        if not re.fullmatch(r'[0-9]+', str(run_id)):
            raise ValueError('run-id は数値で指定してください')
        run = json.loads(self.run('gh', 'api', f'repos/{REPOSITORY}/actions/runs/{run_id}', capture=True))
        if run['conclusion'] != 'success' or run.get('head_branch') != 'main':
            raise ValueError('main の成功したリリースを指定してください')
        print(f"Release: {run['html_url']}\nSource: {run['head_sha']}", flush=True)
        # Bind verification to GitHub's successful run metadata, not the downloaded manifest.
        sha = self.args.source_sha or selection.get('source_sha') or run['head_sha']
        if not re.fullmatch(r'[a-f0-9]{40}', sha) or sha != run['head_sha']:
            raise ValueError('指定または記録済みの SHA とリリース実行のソースが一致しません')
        if selection.get('run_attempt', run['run_attempt']) != run['run_attempt']:
            raise ValueError('記録したリリースの実行回が変わりました。再開では別の配布物へ切り替えません')
        self.selected_release = {'run_id': str(run_id), 'source_sha': sha, 'run_attempt': run['run_attempt']}
        if not updating:
            self.state.update({'cluster': self.cluster, 'url': self.url, 'ai': getattr(self, 'ai', 'openrouter'), **self.selected_release})
            private_json(self.state_path, self.state)
        release = self.directory / 'release' / f'{run_id}-attempt-{run["run_attempt"]}'
        release.mkdir(parents=True, exist_ok=True)
        required = ('release.json', f'videoq-0.1.0-sha.{sha}.tgz', f'videoq-inference-0.1.0-sha.{sha}.tgz')
        if not all((release / name).is_file() and (release / name).stat().st_size for name in required):
            with tempfile.TemporaryDirectory(dir=release.parent) as download:
                self.run('gh', 'run', 'download', str(run_id), '--repo', REPOSITORY,
                         '--name', f'onprem-release-{sha}-attempt-{run["run_attempt"]}', '--dir', download)
                shutil.copytree(download, release, dirs_exist_ok=True)
        # Never trust locally generated values without rechecking the signed manifest.
        self.run(sys.executable, str(ROOT / '.github/scripts/onprem-release.py'), 'verify', sha,
                 str(release / 'release.json'), str(release / 'verified-images.json'), str(release / 'verified-inference.json'))
        manifest = json.loads((release / 'release.json').read_text())
        self.chart = release / manifest['charts']['application']['name']
        self.inference_chart = release / manifest['charts']['inference']['name'] if 'inference' in manifest['charts'] else None
        self.inference_images = release / 'verified-inference.json'
        self.images = release / 'verified-images.json'
        self.refs = image_refs(json.loads(self.images.read_text()))

    def prepare_host(self):
        setting = Path('/proc/sys/fs/inotify/max_user_instances')
        if not setting.exists() or int(setting.read_text().strip()) >= 1024:
            return False
        content = '# Required for coexisting k3d/K3s and host file watchers.\nfs.inotify.max_user_instances = 1024\n'
        destination = Path('/etc/sysctl.d/90-videoq-k3s.conf')
        if destination.exists() and destination.read_text() != content:
            raise ValueError('既存の /etc/sysctl.d/90-videoq-k3s.conf を上書きできません。監視上限を確認してください')
        self.stage('K3s 用のホスト監視上限を 1024 に設定します（再起動後も保持）')
        with tempfile.NamedTemporaryFile(mode='w') as config:
            config.write(content)
            config.flush()
            self.run('sudo', '-n', 'install', '-m', '0644', config.name, str(destination))
        self.run('sudo', '-n', 'sysctl', '-w', 'fs.inotify.max_user_instances=1024')
        return True

    def wait_node(self, node, timeout=180):
        deadline = time.monotonic() + timeout
        next_report = 0
        self.stage('K3s ノードの登録と Ready を待ちます')
        while time.monotonic() < deadline:
            result = subprocess.run(['kubectl', '--kubeconfig', str(self.kubeconfig), '--request-timeout=10s',
                                     'get', 'nodes', '-o', 'json'], text=True, capture_output=True)
            if result.returncode == 0:
                nodes = json.loads(result.stdout).get('items', [])
                if any(n['metadata']['name'] == node and any(c['type'] == 'Ready' and c['status'] == 'True'
                       for c in n.get('status', {}).get('conditions', [])) for n in nodes):
                    print('K3s node Ready: ' + node, flush=True)
                    return
            if time.monotonic() >= next_report:
                print('ノード登録・準備完了を確認中…', flush=True)
                next_report = time.monotonic() + 20
            time.sleep(2)
        raise ValueError('K3s ノードが登録されないか Ready になりません。クラスタは保持しています。サーバーの containerd ログとホストの監視上限・メモリを確認し、同じコマンドで再開してください')

    def ensure_cluster(self):
        host_changed = self.prepare_host()
        self.stage('2/6 単一ノード K3s と公開ポート 443 を準備します')
        clusters = json.loads(self.k3d('cluster', 'list', '-o', 'json', capture=True))
        node = 'k3d-' + self.cluster + '-server-0'
        proxy = 'k3d-' + self.cluster + '-serverlb'
        exists = any(c['name'] == self.cluster for c in clusters)
        if exists:
            info = json.loads(self.run(*self.docker_prefix, 'docker', 'inspect', node, capture=True))[0]
            expected = str(self.directory / 'storage')
            if not any(m['Destination'] == '/var/lib/rancher/k3s/storage' and m['Source'] == expected for m in info['Mounts']):
                raise ValueError('既存クラスタの保存先が異なります。別環境を上書きできません')
            if host_changed:
                self.run(*self.docker_prefix, 'docker', 'restart', node, capture=True)
            self.k3d('cluster', 'start', self.cluster)
            bindings = json.loads(self.run(*self.docker_prefix, 'docker', 'inspect', proxy, capture=True))[0]['HostConfig']['PortBindings']
            public = [b for b in (bindings.get('30443/tcp') or []) if b['HostPort'] == '443' and b['HostIp'] in ('', '0.0.0.0')]
            if not public:
                self.check_port()
                self.k3d('node', 'edit', proxy, '--port-add', '0.0.0.0:443:30443')
        else:
            if self.ai == 'local-gpu':
                raise ValueError('local-gpu は GPU 対応済みの k3d/K3s クラスタが必要です。NVIDIA runtime・device plugin・GPU パススルーを先に構成してください。CPU 専用の既定ノードは作成しません')
            self.check_port()
            (self.directory / 'storage').mkdir(exist_ok=True)
            self.k3d('cluster', 'create', self.cluster, '--servers', '1', '--agents', '0', '--api-port', '127.0.0.1:16444',
                     '--image', K3S, '--volume', str(self.directory / 'storage') + ':/var/lib/rancher/k3s/storage@server:0',
                     '--port', '0.0.0.0:443:30443@loadbalancer', '--k3s-arg', '--disable=traefik,metrics-server,servicelb@server:0',
                     '--kubeconfig-update-default=false', '--kubeconfig-switch-context=false', '--timeout', '180s')
        config = self.k3d('kubeconfig', 'get', self.cluster, capture=True)
        # kubeconfigs contain credentials; never print them.
        with self.kubeconfig.open('w') as stream:
            os.chmod(self.kubeconfig, 0o600)
            stream.write(config)
        self.run(*self.docker_prefix, 'docker', 'update', '--restart', 'unless-stopped', node, proxy, capture=True)
        self.wait_node(node)
        self.apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'videoq'}})

    @staticmethod
    def check_port():
        with socket.socket() as listener:
            try:
                listener.bind(('0.0.0.0', 443))
            except OSError as error:
                if error.errno == errno.EACCES:
                    return  # Docker publishes the privileged port through its daemon.
                raise ValueError('443番ポートが使用中です。既存の入口を確認してください') from error

    def credentials(self):
        self.stage('3/6 認証情報を準備します（既存の暗号鍵は保持します）')
        available = json.loads(self.kube('get', 'secrets', '-o', 'json', capture=True))['items']
        names = ('videoq-runtime', 'videoq-postgres', 'videoq-garage')
        existing = {s['metadata']['name']: {k: base64.b64decode(v).decode() for k, v in s.get('data', {}).items()}
                    for s in available if s['metadata']['name'] in names}
        path = self.directory / 'credentials.json'
        if existing:
            if set(existing) != set(names):
                raise ValueError('認証用 Secret が一部だけ存在します。既存データとの整合性を確認してください')
            values = existing
        elif path.exists():
            values = json.loads(path.read_text())
        else:
            mode = getattr(self, 'ai', 'openrouter')
            key = (os.getenv('VIDEOQ_OPENROUTER_API_KEY') or getpass.getpass('OpenRouter API key: ')) if mode == 'openrouter' else 'local-inference'
            values = new_credentials(key, self.url, mode)
        values['videoq-garage']['GARAGE_CORS_ORIGINS'] = self.url
        runtime = values['videoq-runtime']
        if getattr(self, 'ai', 'openrouter') != 'openrouter':
            runtime.pop('OPENROUTER_API_KEY', None)
            runtime.setdefault('OPENAI_API_KEY', (os.getenv('VIDEOQ_LOCAL_AI_KEY') or 'local-inference'))
        for key in ('BETTER_AUTH_URL', 'FRONTEND_URL', 'CORS_ALLOW_ORIGIN', 'OAUTH_ISSUER_URL', 'R2_S3_ENDPOINT'):
            if key in runtime:
                runtime[key] = self.url
        private_json(path, values)
        for name, data in values.items():
            self.apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': name}, 'type': 'Opaque', 'stringData': data})

    def backing_services(self):
        self.stage('4/6 永続基盤・HTTPS・ストレージを設定します')
        config = {name: (EXAMPLE / name).read_text() for name in ('garage.toml', 'elasticmq.conf')}
        config['Caddyfile'] = caddyfile(self.url)
        self.apply({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'videoq-infra-config'}, 'data': config})
        raw = self.kube('create', '--dry-run=client', '--validate=false', '-f', str(EXAMPLE / 'infrastructure.yaml'), '-o', 'json', capture=True)
        objects = infrastructure(json_documents(raw), config)
        private_json(self.directory / 'infrastructure-public.json', {'apiVersion': 'v1', 'kind': 'List', 'items': objects})
        self.apply({'apiVersion': 'v1', 'kind': 'List', 'items': objects})
        for name in ('postgres', 'garage', 'queue', 'videoq-gateway'):
            self.kube('rollout', 'status', 'deployment/' + name, '--timeout=300s')
        script = (ROOT / 'infra/garage/init.py').read_text()
        self.apply({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'videoq-storage-init'}, 'data': {'init.py': script}})
        suffix = hashlib.sha256((self.url + self.refs['worker'] + script).encode()).hexdigest()[:12]
        job_name = 'videoq-storage-init-' + suffix
        found = json.loads(self.kube('get', 'jobs', '-o', 'json', capture=True))['items']
        current = next((j for j in found if j['metadata']['name'] == job_name), None)
        if current and any(c['type'] == 'Failed' and c['status'] == 'True' for c in current.get('status', {}).get('conditions', [])):
            self.kube('delete', 'job', job_name)
            current = None
        if not current:
            self.apply({'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': job_name}, 'spec': {
                'backoffLimit': 2, 'activeDeadlineSeconds': 180, 'template': {'spec': {'restartPolicy': 'Never', 'automountServiceAccountToken': False,
                'containers': [{'name': 'init', 'image': self.refs['worker'], 'command': ['python', '/scripts/init.py'],
                                'envFrom': [{'secretRef': {'name': 'videoq-garage'}}],
                                'volumeMounts': [{'name': 'script', 'mountPath': '/scripts', 'readOnly': True}]}],
                'volumes': [{'name': 'script', 'configMap': {'name': 'videoq-storage-init'}}]}}}})
        self.kube('wait', '--for=condition=complete', 'job/' + job_name, '--timeout=180s')

    def desired_application_values(self):
        path = self.directory / 'site-public.json'
        return json.loads(path.read_text()) if path.exists() else site_values(self.url)

    def application(self, replicas=None):
        self.stage('5/6 検証済み Chart を Helm で導入します')
        values = self.directory / 'site-public.json'
        desired = self.desired_application_values()
        if replicas:
            for component in ('api', 'web', 'worker'):
                desired.setdefault(component, {})['replicas'] = replicas['deployments']['videoq-' + component]['replicas']
        private_json(values, desired)
        self.run('helm', 'upgrade', '--install', 'videoq', str(self.chart), '--kubeconfig', str(self.kubeconfig), '-n', 'videoq',
                 '-f', str(values), *self.ai_application_values(), '-f', str(self.images), '--wait', '--timeout', '15m')
        self.test_application()

    def test_application(self):
        # Helm readiness may precede EndpointSlice/kube-proxy convergence by a few seconds.
        for attempt in range(3):
            try:
                self.run('helm', 'test', 'videoq', '--kubeconfig', str(self.kubeconfig), '-n', 'videoq',
                         '--timeout', '2m', '--logs')
                return
            except subprocess.CalledProcessError:
                if attempt == 2:
                    raise
                print('疎通テストが失敗しました。Service 経路の反映を待って再試行します（' + str(attempt + 2) + '/3）', flush=True)
                time.sleep(5)

    def check_public_storage(self):
        # NetworkPolicy can deliberately deny public egress from application Pods.
        # Generate signatures in the worker; exercise the public route from the VPS.
        script = (ROOT / 'scripts/onprem/public-storage-check.py').read_text()
        probe = json.loads(self.kube('exec', '-i', 'deployment/videoq-worker', '--', 'python', '-', '--prepare',
                                    data=script, capture=True))
        payload = base64.b64decode(probe['payload'])
        try:
            with urlopen(Request(probe['put'], data=payload, method='PUT', headers={'Content-Type': 'application/octet-stream'}), timeout=20) as response:
                if response.status != 200:
                    raise ValueError('S3 upload')
            with urlopen(probe['get'], timeout=20) as response:
                if response.read() != payload or 'sandbox' not in response.headers.get('Content-Security-Policy', ''):
                    raise ValueError('S3 download or media sandbox')
                if response.headers.get('X-Content-Type-Options') != 'nosniff':
                    raise ValueError('S3 MIME protection')
            with urlopen(Request(probe['get'], headers={'Range': 'bytes=0-5'}), timeout=20) as response:
                if response.status != 206 or response.read() != payload[:6]:
                    raise ValueError('S3 video Range')
        except Exception as error:
            raise ValueError('公開 S3 の検証に失敗しました (' + type(error).__name__ + ')') from None
        finally:
            self.kube('exec', '-i', 'deployment/videoq-worker', '--', 'python', '-', '--cleanup', probe['key'], data=script)
        print('OK: public HTTPS S3 PUT/GET, video Range and media sandbox; probe removed.', flush=True)

    def finish(self, provision=True):
        self.stage('6/6 公開 HTTPS を確認します（証明書の発行を待ちます）')
        deadline = time.monotonic() + 300
        last_report = 0
        while True:
            try:
                with urlopen(self.url + '/ready', timeout=10) as response:
                    if response.status == 200:
                        break
            except (URLError, TimeoutError, OSError):
                pass
            if time.monotonic() > deadline:
                raise ValueError('HTTPS の準備が完了しません。VPS/上位ファイアウォールの TCP 443 と gateway のログを確認し、同じコマンドで再開してください')
            if time.monotonic() - last_report > 20:
                print('HTTPS の証明書と /ready を確認中…', flush=True)
                last_report = time.monotonic()
            time.sleep(3)
        self.check_public_storage()
        if provision and not self.state.get('admin_created'):
            username = self.args.username or input('管理者ユーザー名 [site_admin]: ').strip() or 'site_admin'
            email = self.args.email or input('管理者メールアドレス: ').strip()
            if not email:
                raise ValueError('管理者メールアドレスを指定してください。同じコマンドで再開できます')
            result = self.kube('exec', 'deployment/videoq-api', '--', 'node', 'dist/provision-user.mjs',
                               '--admin', '--username', username, '--email', email, capture=True)
            print(result, flush=True)
            with (self.directory / 'admin-setup.txt').open('w') as stream:
                os.chmod(self.directory / 'admin-setup.txt', 0o600)
                stream.write(result)
            self.state['admin_created'] = True
            private_json(self.state_path, self.state)
        print(f'導入完了: {self.url}\nSSH 転送は不要です。設定・鍵・永続データ: {self.directory}', flush=True)

    def install(self):
        if self.state.get('pending_update'):
            raise ValueError('更新が未完了です。install ではなく update を再実行してください')
        self.tools()
        self.release()
        self.ensure_cluster()
        self.prepare_inference()
        self.credentials()
        self.backing_services()
        self.local_inference()
        self.application()
        self.finish()
        self.state.pop('uninstalled', None)
        self.save_state()

    def execute(self):
        import fcntl
        with (self.directory / '.operation.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            getattr(self, self.args.command)()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['install', 'update', 'uninstall'])
    parser.add_argument('--url', help='公開 HTTPS URL（公開 IPv4 または DNS 名、443番）')
    parser.add_argument('--directory', default=str(Path.home() / 'videoq-kubernetes'))
    parser.add_argument('--cluster', help='クラスタ名（新規導入時の標準: videoq-vps）')
    parser.add_argument('--run-id', help='成功した On-prem Release の実行 ID')
    parser.add_argument('--source-sha', help='任意のソース固定（標準: 成功したリリース実行の SHA を自動取得）')
    parser.add_argument('--ai', choices=['openrouter', 'local-cpu', 'local-gpu'], help='初回の AI 構成（標準: openrouter、再開時は記録した構成）')
    parser.add_argument('--username')
    parser.add_argument('--email')
    parser.add_argument('--backup', help='更新前の新規バックアップ保存先（標準: 導入先/backups）')
    parser.add_argument('--purge', action='store_true', help='uninstall 時にクラスタ・データ・鍵・内部バックアップも削除')
    parser.add_argument('--yes', action='store_true', help='uninstall --purge の確認入力を省略')
    args = parser.parse_args()
    if args.backup and args.command != 'update':
        parser.error('--backup は update 専用です')
    if args.purge and args.command != 'uninstall':
        parser.error('--purge は uninstall 専用です')
    if args.yes and not args.purge:
        parser.error('--yes は uninstall --purge 専用です')
    try:
        Installer(args).execute()
    except (ValueError, OSError, subprocess.CalledProcessError, EOFError) as error:
        # Secret values are passed on stdin or via private files, never argv.
        print(f'導入を停止しました: {error}\n原因を解消後、同じコマンドで再開してください。既存の鍵とデータは保持します。', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
