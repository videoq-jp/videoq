#!/usr/bin/env python3
"""Install one native Ubuntu RTX 4090 host, three CUDA engines and VideoQ.

Dedicated host only. The shell entrypoint installs OS prerequisites; this CLI
preserves credentials/PVCs, verifies releases, and resumes without changing the
embedding space. The browser endpoint uses public HTTPS on 443, or an explicit loopback SSH origin.
"""
import argparse
import fcntl
import hashlib
import getpass
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
import tempfile
from urllib.request import ProxyHandler, Request, build_opener
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import private_json, json_documents
from k3s import Installer, new_credentials, ROOT, EXAMPLE
import public_release
from endpoint import network_details, prepare_certificate, private_pem, verified_opener
from native import application_values, backing_plan, forwarding_units, local_origin, browser_origin, model_contract

K3S_VERSION = 'v1.37.2+k3s1'
PLUGIN_VERSION = '0.20.1'
DRIVER_MIN = (580, 65, 6)
PROFILE = ROOT / 'charts/videoq-inference/examples/rtx4090-gpt-oss-embeddinggemma.yaml'


def admin_details(username, email, ask=input):
    username = (username or ask('管理者ユーザー名 [site_admin]: ').strip() or 'site_admin').strip().lower()
    email = (email or ask('管理者メールアドレス: ').strip()).strip().lower()
    if not re.fullmatch(r'[a-z0-9_]{3,30}', username):
        raise ValueError('ユーザー名は3〜30文字の英小文字・数字・アンダースコアで指定してください')
    if not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+", email) or len(email) > 254 or email.startswith('.') or '.@' in email or '..' in email:
        raise ValueError('有効な管理者メールアドレスを指定してください')
    return {'username': username, 'email': email}


def initial_password(ask=getpass.getpass):
    """Keep new passwords out of argv, environment, state and installation logs."""
    while True:
        password = ask('管理者の初回パスワード（12〜128文字、空欄ならブラウザで設定）: ')
        if not password:
            return None
        if not 12 <= len(password) <= 128:
            print('パスワードは12〜128文字で指定してください。')
            continue
        if password != ask('初回パスワード（確認）: '):
            print('確認用パスワードが一致しません。もう一度入力してください。')
            continue
        return password


def activate_admin(url, activation_url, password, opener=None):
    expected, target = urlsplit(browser_origin(url)), urlsplit(activation_url)
    prefix = '/api/auth/reset-password/'
    token = target.path[len(prefix):] if target.path.startswith(prefix) else ''
    if (target.scheme, target.netloc) != (expected.scheme, expected.netloc) or not re.fullmatch(r'[A-Za-z0-9_-]{16,256}', token):
        raise ValueError('初回設定リンクの接続先またはトークンが不正です')
    if not 12 <= len(password) <= 128:
        raise ValueError('パスワードの長さが不正です')
    request = Request(url + '/api/auth/reset-password', method='POST',
                      headers={'Content-Type': 'application/json', 'Origin': url},
                      data=json.dumps({'token': token, 'newPassword': password}).encode())
    client = opener or build_opener(ProxyHandler({}))
    try:
        with client.open(request, timeout=20) as response:
            if response.status != 200 or json.load(response).get('status') is not True:
                raise ValueError('初回パスワードを設定できませんでした')
    except Exception:
        # Do not format an HTTP error/body that could expose request credentials.
        raise ValueError('初回パスワードを設定できませんでした。保存済みリンクをブラウザで開いてください') from None


class NativeInstaller:
    def __init__(self, args):
        self.args = args
        self.directory = Path(args.directory).expanduser().resolve()
        if any(c in str(self.directory) for c in '\n\r\x00%') or any(c.isspace() for c in str(self.directory)):
            raise ValueError('導入先パスには空白・改行・%を使用できません')
        protected = {Path(p).resolve() for p in ('/', '/root', '/home', '/var', '/var/lib', '/opt', '/tmp', '/srv')}
        blocked = ('/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/dev', '/proc', '/sys', '/boot', '/root/.ssh', '/root/.config', '/root/.gnupg')
        if self.directory in protected or any(self.directory == Path(p).resolve() or Path(p).resolve() in self.directory.parents for p in blocked):
            raise ValueError('システムディレクトリを導入先には指定できません')
        if any((p / '.git').exists() for p in (self.directory, *self.directory.parents)):
            raise ValueError('秘密情報の保存先は Git リポジトリの外にしてください')
        if self.directory.is_dir() and any(p.name != '.install.lock' for p in self.directory.iterdir()) and not (self.directory / 'installation.json').exists() and not args.adopt_existing:
            raise ValueError('既存ディレクトリを自動採用しません。新しい導入先を指定してください')
        self.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        os.chmod(self.directory, 0o700)
        self.lock = (self.directory / '.install.lock').open('a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise ValueError('別のインストールが実行中です') from None
        try:
            self.configure(args)
        except BaseException:
            self.lock.close()
            raise

    def configure(self, args):
        self.state_path = self.directory / 'installation.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        if self.state and self.state.get('kind') != 'native-rtx4090':
            raise ValueError('別形式の導入記録です。既存の環境は変更しません')
        requested_url, self.network = network_details(args, self.state)
        self.url = browser_origin(requested_url)
        old_url = self.state.get('url')
        if self.state.get('pending_url') and self.state['pending_url'] != self.url:
            raise ValueError('URL移行が未完了です。記録した移行先URLで再開してください')
        self.migrating_url = bool(old_url and old_url != self.url)
        if self.migrating_url:
            if not args.migrate_url and self.state.get('pending_url') != self.url:
                raise ValueError('URL変更には --migrate-url を明示してください。データと鍵は保持します')
            if self.state.get('pending_url') not in (None, self.url):
                raise ValueError('別URLへの移行が未完了です。記録したURLで再開してください')
            self.state['pending_url'] = self.url
        for field in ('run_id', 'source_sha'):
            requested = getattr(args, field)
            if requested and self.state.get(field) and str(requested) != str(self.state[field]):
                raise ValueError('再開時のリリースは変更できません。バックアップ後に更新を計画してください')
        self.storage_gib = args.storage_gib if args.storage_gib is not None else self.state.get('storage_gib', 40)
        if not 10 <= self.storage_gib <= 10000:
            raise ValueError('ストレージサイズは10〜10000 GiBで指定してください')
        if self.state.get('storage_gib', self.storage_gib) != self.storage_gib:
            raise ValueError('既存のlocal-path PVCサイズは変更できません')
        recorded = self.state.get('admin', {})
        self.admin = admin_details(args.username or recorded.get('username'), args.email or recorded.get('email'))
        if recorded and recorded != self.admin and (self.state.get('admin_created') or self.state.get('admin_provisioning')):
            raise ValueError('再実行で既存管理者を変更できません')
        self.state.update(kind='native-rtx4090', admin=self.admin, storage_gib=self.storage_gib)
        self.state.setdefault('url', self.url)
        self.cluster, self.ai = 'native-rtx4090', 'local-rtx4090'
        self.host_kubeconfig = Path('/etc/rancher/k3s/k3s.yaml')
        self.kubeconfig = self.directory / 'kubeconfig'
        os.environ['KUBECONFIG'] = str(self.kubeconfig)
        os.environ['PATH'] = '/usr/local/bin:' + str(Path.home() / '.local/bin') + ':' + os.environ['PATH']
        prepare_certificate(self.directory, self.network, self.url)
        self.network = {key: self.network[key] for key in ('listen_ip', 'tls_mode')}
        self.state['network'] = self.network
        private_json(self.state_path, self.state)

    def run(self, *args, capture=False, data=None):
        return subprocess.run(list(map(str, args)), input=data, text=True, check=True,
                              stdout=subprocess.PIPE if capture else None).stdout

    def system(self, *args, **kwargs):
        return self.run('sudo', *(['-n'] if os.environ.get('VIDEOQ_NONINTERACTIVE') == '1' else []), '--', *args, **kwargs)

    def kube(self, *args, **kwargs):
        return self.run('k3s', 'kubectl', '--kubeconfig', self.kubeconfig, '-n', 'videoq', *args, **kwargs)

    def apply(self, obj):
        return self.kube('apply', '-f', '-', data=json.dumps(obj))

    def stage(self, message):
        if message.startswith('1/6 '):
            message = '署名済みリリースを取得し、ソースと証明を検証します'
        print('\n' + message, flush=True)

    def record(self, **values):
        self.state.update(values)
        private_json(self.state_path, self.state)

    def host(self):
        import socket
        try:
            with socket.socket() as probe:
                probe.bind((self.network['listen_ip'], 0))
        except OSError:
            raise ValueError('待受IPがこのマシンに割り当てられていません。IP固定・DHCP予約を確認してください') from None
        if os.geteuid() == 0:
            raise ValueError('通常ユーザーで bash scripts/onprem/install-rtx4090.sh を実行してください')
        release = platform.freedesktop_os_release()
        if platform.system() != 'Linux' or platform.machine() != 'x86_64' or release.get('ID') != 'ubuntu' or release.get('VERSION_ID') not in {'22.04', '24.04'}:
            raise ValueError('Ubuntu 22.04/24.04 amd64 の専用ホストが必要です')
        if self.host_kubeconfig.exists() and not self.state.get('cluster_owned') and not self.args.adopt_existing:
            raise ValueError('既存のK3sを検出しました。専用ホストへの導入と確認できる場合のみ --adopt-existing を指定してください')
        memory = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:'))) * 1024
        if memory < 32 * 1024 ** 3 or os.cpu_count() < 8:
            raise ValueError('CPU 8コア以上・使用可能なRAM 32GiB以上が必要です（推奨16コア・48GiB）')
        # Installation must leave room for model snapshots, both image stores and media.
        minimum = 12 if self.state.get('inference_ready') else 90
        if shutil.disk_usage(self.directory).free < minimum * 1024 ** 3:
            raise ValueError(f'導入先に空き {minimum}GiB 以上が必要です（ディスク全体は200GB以上を推奨）')
        self.stage('1/7 Ubuntu・RTX 4090・Docker・NVIDIA runtime を確認します')
        result = subprocess.run(['nvidia-smi', '--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'], capture_output=True, text=True) if shutil.which('nvidia-smi') else None
        if not result or result.returncode:
            raise ValueError('NVIDIA ドライバーが準備できていません。シェルのブートストラップから再実行してください')
        rows = [r.split(',') for r in result.stdout.strip().splitlines()]
        if len(rows) != 1 or rows[0][0].strip() not in ('NVIDIA GeForce RTX 4090', 'NVIDIA RTX 4090') or float(rows[0][2]) < 23000:
            raise ValueError('24GB RTX 4090 が物理的に1枚あるホストが必要です')
        if tuple(map(int, rows[0][1].strip().split('.'))) < DRIVER_MIN:
            raise ValueError('CUDA 13対応の NVIDIA 580.65.06以降が必要です')
        self.system('docker', 'info', capture=True)
        self.run('nvidia-container-runtime', '--version', capture=True)

    def tools(self):
        if not shutil.which('helm') or not public_release.verifier_ready():
            self.run('bash', ROOT / 'scripts/onprem/install-tools.sh')

    def runtime_matches(self, sha):
        if not re.fullmatch(r'[a-f0-9]{40}', sha):
            raise ValueError('不正なリリース SHA です')
        probe = subprocess.run(['git', '-C', str(ROOT), 'cat-file', '-e', sha + '^{commit}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode:
            self.run('git', '-C', ROOT, 'fetch', '--depth=1', 'origin', sha)
        for name in ('server.py', 'provision.py', 'Dockerfile.vllm', 'pyproject.toml', 'uv.lock'):
            path = 'apps/inference/whisper/' + name
            signed = subprocess.check_output(['git', '-C', str(ROOT), 'show', sha + ':' + path])
            if signed != (ROOT / path).read_bytes():
                return False
        return True

    def reselect_incomplete_release(self):
        """Repair a partial install after its source recipe receives a fix.

        Never use an install rerun as an application update. Existing application
        state and explicit release pins require the normal update/recovery path.
        """
        if self.args.run_id or self.args.source_sha or not self.state.get('source_sha'):
            return False
        if self.runtime_matches(self.state['source_sha']):
            return False
        if self.state.get('complete') or self.state.get('admin_created'):
            raise ValueError('稼働済み環境のリリースはインストーラーで変更しません。更新手順を使用してください')
        if self.state.get('cluster_owned') or self.host_kubeconfig.exists():
            for kind, name in (('deployment', 'videoq-api'), ('secret', 'videoq-runtime')):
                if self.kube('get', kind, name, '--ignore-not-found', '-o', 'name', capture=True).strip():
                    raise ValueError('既存アプリを検出しました。リリースを自動変更せず、更新手順を使用してください')
        from update_policy import release_order
        candidates = public_release.releases()
        previous = (int(self.state['run_id']), self.state['run_attempt'])
        selected = next((row for row in candidates
                         if (int(row['run_id']), row['run_attempt']) > previous
                         and release_order(self.state, row)
                         and self.runtime_matches(row['source_sha'])), None)
        if selected is None:
            raise ValueError('修正ソースに対応する署名済みReleaseの公開待ちです。保存済みデータ・重みは保持しています')
        self.public_releases = [selected]
        # updating=True verifies the successful main run, bundles and digests
        # without replacing the saved installation pin before verification.
        Installer.release(self, updating=True)
        if not self.runtime_matches(self.selected_release['source_sha']):
            raise ValueError('修正版Releaseとソースが一致しません。導入記録は変更しません')
        backup = self.directory / ('installation.before-release-' + str(self.state['run_id'])
                                   + '-attempt-' + str(self.state['run_attempt']) + '.json')
        if not backup.exists():
            private_json(backup, self.state)
        self.record(**self.selected_release)
        print('未完了の導入を、検証済みの対応する修正版Releaseで再開します。', flush=True)
        return True

    def release(self):
        if self.reselect_incomplete_release():
            return
        # Pick the newest compatible successful release, then verify its run/SLSA binding.
        if not self.args.run_id and not self.state.get('run_id'):
            self.public_releases = public_release.releases()
            selected = next((release for release in self.public_releases if (not self.args.source_sha or release['source_sha'] == self.args.source_sha) and self.runtime_matches(release['source_sha'])), None)
            if not selected:
                raise ValueError('推論ランタイムが一致する公開リリースがありません。対応する公開版を指定してください')
            self.args.run_id = selected['run_id']
        previous_url = self.state['url']
        try:
            Installer.release(self)
        finally:
            if self.migrating_url:
                self.state['url'] = previous_url
                self.record(pending_url=self.url)
        if not self.runtime_matches(self.state['source_sha']):
            raise ValueError('署名済み推論ランタイムとソースが異なります。対応するリリースを選択してください')

    def refresh_kubeconfig(self):
        content = self.system('cat', self.host_kubeconfig, capture=True)
        with tempfile.NamedTemporaryFile(mode='w', dir=self.directory, delete=False) as temporary:
            staged = Path(temporary.name)
            try:
                os.chmod(staged, 0o600)
                temporary.write(content)
                temporary.close()
                os.replace(staged, self.kubeconfig)
            finally:
                staged.unlink(missing_ok=True)

    def wait_native_node(self, timeout=180):
        """The API can answer before the first kubelet registers its node."""
        deadline = time.monotonic() + timeout
        self.stage('K3s ノードの登録と Ready を待ちます')
        while time.monotonic() < deadline:
            try:
                nodes = json.loads(self.kube('--request-timeout=10s', 'get', 'nodes', '-o', 'json', capture=True))['items']
            except subprocess.CalledProcessError:
                nodes = []
            if len(nodes) > 1:
                raise ValueError('このインストーラーは1ノード専用です')
            if nodes and any(c.get('type') == 'Ready' and c.get('status') == 'True'
                             for c in nodes[0].get('status', {}).get('conditions', [])):
                return nodes[0]['metadata']['name']
            time.sleep(2)
        raise ValueError('K3s ノードが登録されないか Ready になりません。環境を保持しています。同じコマンドで再開できます。')

    def check_cluster_identity(self, *, enroll=False):
        uid = self.kube('get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}', capture=True).strip()
        if not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', uid):
            raise ValueError('K3sクラスタの識別情報を確認できません')
        recorded = self.state.get('cluster_uid')
        if recorded is not None and recorded != uid:
            raise ValueError('導入記録とは別のクラスタです。更新・復元を実行しません')
        if recorded is None:
            if not enroll:
                raise ValueError('クラスタ識別情報が未登録です。先にインストーラーを再実行してください')
            self.record(cluster_uid=uid)
        return uid

    def ensure_cluster(self):
        self.stage('2/7 既存または新規の native K3s を準備します')
        self.record(cluster_owned=True)
        if not self.host_kubeconfig.exists():
            script = self.directory / 'install-k3s.sh'
            self.run('curl', '-fsSL', 'https://get.k3s.io', '-o', script)
            self.system('env', 'INSTALL_K3S_VERSION=' + K3S_VERSION, 'sh', script, 'server', '--disable', 'traefik', '--disable', 'servicelb', '--write-kubeconfig-mode', '600')
        self.refresh_kubeconfig()
        self.node = self.wait_native_node()
        self.check_cluster_identity(enroll=True)
        if subprocess.run(['k3s', 'kubectl', '--kubeconfig', str(self.kubeconfig), 'get', 'runtimeclass', 'nvidia'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            self.system('systemctl', 'restart', 'k3s')
            self.node = self.wait_native_node()
        self.kube('get', 'runtimeclass', 'nvidia')
        self.kube('create', 'namespace', 'videoq', '--dry-run=client', '-o', 'json', capture=True) # validate before apply
        self.apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'videoq'}})
        self.kube('label', 'node', self.node, 'videoq.io/inference-target=rtx4090', 'nvidia.com/gpu.present=true', '--overwrite')
        self.run('helm', 'upgrade', '--install', 'nvdp', 'nvidia-device-plugin', '--repo', 'https://nvidia.github.io/k8s-device-plugin', '--version', PLUGIN_VERSION,
                 '-n', 'nvidia-device-plugin', '--create-namespace', '-f', ROOT / 'charts/videoq-inference/examples/rtx4090-device-plugin.yaml', '--wait', '--timeout', '5m')
        self.run('k3s', 'kubectl', '--kubeconfig', self.kubeconfig, '-n', 'nvidia-device-plugin', 'rollout', 'status', 'daemonset/nvdp-nvidia-device-plugin', '--timeout=180s')
        for attempt in range(90):
            node = json.loads(self.kube('get', 'node', self.node, '-o', 'json', capture=True))
            if node['status']['allocatable'].get('nvidia.com/gpu.shared') == '3':
                break
            if attempt == 89:
                raise ValueError('Device Plugin が共有GPUスロットを3つ公開していません')
            time.sleep(2)
        self.record(cluster_owned=True, node=self.node)

    def inference(self):
        self.stage('3/7 3モデルを1枚の4090に配置します（初回は重みを取得します）')
        claim = 'videoq-gpt-oss-4090'
        self.apply({'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {'name': claim},
                    'spec': {'accessModes': ['ReadWriteOnce'], 'storageClassName': 'local-path', 'resources': {'requests': {'storage': '20Gi'}}}})
        values = {'requireImageDigests': True, 'servers': {'chat': {'persistence': {'existingClaim': claim}}}}
        self.inference_values = self.directory / 'inference-site.json'
        private_json(self.inference_values, values)
        args = ['-f', PROFILE, '-f', self.inference_images, '-f', self.inference_values]
        raw = self.run('helm', 'template', 'inference', ROOT / 'charts/videoq-inference', '-n', 'videoq', *args, capture=True)
        plan = json_documents(self.kube('create', '--dry-run=client', '--validate=false', '-f', '-', '-o', 'json', data=raw, capture=True))
        contract = model_contract(plan)
        if not self.state.get('embedding_contract'):
            api = self.kube('get', 'deployment', 'videoq-api', '--ignore-not-found', '-o', 'name', capture=True).strip()
            if api:
                live = self.kube('get', 'deployment', 'videoq-inference-embedding', '--ignore-not-found', '-o', 'json', capture=True)
                if not live or model_contract([json.loads(live)]) != contract:
                    raise ValueError('既存アプリの埋め込み空間を変更しません。既存設定を確認してください')
        if self.state.get('embedding_contract', contract) != contract:
            raise ValueError('埋め込みモデルの設定が変わるため自動再適用できません。再索引を計画してください')
        # Record before applying so interrupted installations cannot change vector spaces.
        self.record(embedding_contract=contract)
        private_json(self.directory / 'inference-plan.json', {'apiVersion': 'v1', 'kind': 'List', 'items': plan})
        self.run('helm', 'upgrade', '--install', 'inference', ROOT / 'charts/videoq-inference', '-n', 'videoq', *args, '--wait', '--timeout', '45m')
        self.run(sys.executable, ROOT / 'scripts/gpu/rtx4090-preflight.py', '--node', self.node)
        self.record(inference_ready=True)

    def credentials(self):
        file = self.directory / 'credentials.json'
        if not file.exists():
            if self.kube('get', 'secret', 'videoq-runtime', '--ignore-not-found', '-o', 'name', capture=True).strip():
                raise ValueError('既存 Secret に対応する credentials.json がありません。鍵を自動生成し直しません')
            private_json(file, new_credentials('local-inference', self.url, 'local-gpu'))
        values = json.loads(file.read_text())
        if self.migrating_url:
            values['videoq-garage']['GARAGE_CORS_ORIGINS'] = self.url
            private_json(file, values)
        for name in ('videoq-runtime', 'videoq-postgres', 'videoq-garage'):
            if not isinstance(values.get(name), dict) or not values[name]:
                raise ValueError('保存済みの認証情報が不完全です')
            existing = self.kube('get', 'secret', name, '--ignore-not-found', '-o', 'json', capture=True)
            if existing:
                import base64
                current = json.loads(existing).get('data', {})
                if any(base64.b64decode(current.get(key, '')).decode() != value and not (self.migrating_url and name == 'videoq-garage' and key == 'GARAGE_CORS_ORIGINS' and base64.b64decode(current.get(key, '')).decode() == self.state['url']) for key, value in values[name].items()):
                    raise ValueError('保存済みファイルと既存 Secret が異なります。鍵を変更しません: ' + name)
            self.apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': name}, 'type': 'Opaque', 'stringData': values[name]})

    def backing(self):
        self.stage('4/7 PostgreSQL・動画ストレージ・キューを配置します')
        self.credentials()
        raw = self.kube('create', '--dry-run=client', '--validate=false', '-f', EXAMPLE / 'infrastructure.yaml', '-o', 'json', capture=True)
        mode = self.network['tls_mode']
        tls_hash = None
        if mode == 'provided':
            cert = (self.directory / 'tls/tls.crt').read_bytes()
            key = (self.directory / 'tls/tls.key').read_bytes()
            self.apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'videoq-gateway-tls'},
                        'type': 'kubernetes.io/tls', 'stringData': {'tls.crt': cert.decode(), 'tls.key': key.decode()}})
            tls_hash = hashlib.sha256(cert + key).hexdigest()
        config, objects = backing_plan(EXAMPLE, self.url, self.storage_gib, json_documents(raw), tls_mode=mode)
        if tls_hash:
            for obj in objects:
                if obj['kind'] == 'Deployment' and obj['metadata']['name'] == 'videoq-gateway':
                    obj['spec']['template']['metadata']['annotations']['videoq.jp/tls-hash'] = tls_hash
        self.apply({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'videoq-infra-config'}, 'data': config})
        self.apply({'apiVersion': 'v1', 'kind': 'List', 'items': objects})
        for name in ('postgres', 'garage', 'queue', 'videoq-gateway'):
            self.kube('rollout', 'status', 'deployment/' + name, '--timeout=300s')
        script = (ROOT / 'infra/garage/init.py').read_text()
        self.apply({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'videoq-storage-init'}, 'data': {'init.py': script}})
        job = 'videoq-storage-init-' + hashlib.sha256((self.url + self.refs['worker'] + script).encode()).hexdigest()[:12]
        found = self.kube('get', 'job', job, '--ignore-not-found', '-o', 'json', capture=True)
        if found:
            current = json.loads(found)
            if any(c['type'] == 'Failed' and c['status'] == 'True' for c in current.get('status', {}).get('conditions', [])):
                self.kube('delete', 'job', job); found = ''
        if not found:
            self.apply({'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': job}, 'spec': {'backoffLimit': 2, 'activeDeadlineSeconds': 600,
                'template': {'spec': {'restartPolicy': 'Never', 'automountServiceAccountToken': False,
                'containers': [{'name': 'init', 'image': self.refs['worker'], 'command': ['python', '/scripts/init.py'],
                    'envFrom': [{'secretRef': {'name': 'videoq-garage'}}], 'volumeMounts': [{'name': 'script', 'mountPath': '/scripts', 'readOnly': True}]}],
                'volumes': [{'name': 'script', 'configMap': {'name': 'videoq-storage-init'}}]}}}})
        self.kube('wait', '--for=condition=complete', 'job/' + job, '--timeout=600s')

    def application(self):
        self.stage('5/7 署名済み VideoQ 本体と768次元のDBスキーマを導入します')
        values = self.directory / 'site-public.json'
        private_json(values, application_values(self.url))
        self.run('helm', 'upgrade', '--install', 'videoq', self.chart, '-n', 'videoq', '-f', values,
                 '-f', ROOT / 'charts/videoq/examples/local-ai-gpt-oss.yaml', '-f', self.images, '--wait', '--timeout', '15m')
        Installer.test_application(self)

    def configure_trust(self):
        mode = self.network['tls_mode']
        ca = None
        if mode == 'internal':
            pem = self.kube('exec', 'deployment/videoq-gateway', '--', 'cat', '/data/caddy/pki/authorities/local/root.crt', capture=True)
            # Read only the public root, never the CA's private key.
            import ssl
            ssl.create_default_context(cadata=pem)
            ca = self.directory / 'tls/root-ca.crt'
            if ca.exists() and ca.read_text() != pem:
                raise ValueError('内部CAが保存済みの証明書と異なります。既存CAの復旧を確認してください')
            private_pem(ca, pem.encode())
        elif mode == 'provided' and (self.directory / 'tls/ca.crt').exists():
            ca = self.directory / 'tls/ca.crt'
        self.http_client = verified_opener(ca)
        self.public_urlopen = self.http_client.open

    def forwarding(self):
        self.stage('6/7 HTTPSの443番を設定します' if self.url.startswith('https://') else '6/7 SSH トンネル用の localhost 接続を設定します')
        self.configure_trust()
        public_https = self.url.startswith('https://')
        port = 443 if public_https else urlsplit(self.url).port
        gateway = json.loads(self.kube('get', 'service', 'videoq-gateway', '-o', 'json', capture=True))
        desired = forwarding_units(port, gateway['spec']['clusterIP'], public_https=public_https, bind_ip=self.network['listen_ip'])
        listener = Path('/etc/systemd/system/videoq-port-forward.socket')
        if listener.exists() and listener.read_text() != desired[listener.name]:
            self.system('systemctl', 'stop', 'videoq-port-forward.service', 'videoq-port-forward.socket')
        service = Path('/etc/systemd/system/videoq-port-forward.service')
        if service.exists() and 'kubectl' in service.read_text() and 'port-forward' in service.read_text():
            self.system('systemctl', 'disable', '--now', 'videoq-port-forward.service')
        changed = False
        for name, content in desired.items():
            path = Path('/etc/systemd/system') / name
            if not path.exists() or path.read_text() != content:
                with tempfile.TemporaryDirectory(dir=self.directory) as temporary:
                    staged = Path(temporary) / name
                    staged.write_text(content)
                    self.system('install', '-m', '0644', staged, path)
                changed = True
        if changed:
            self.system('systemctl', 'daemon-reload')
        self.system('systemctl', 'enable', '--now', 'videoq-port-forward.socket')
        if changed:
            self.system('systemctl', 'try-restart', 'videoq-port-forward.service')
        opener = self.http_client
        for attempt in range(30):
            try:
                with opener.open(self.url + '/ready', timeout=5) as res:
                    if res.status == 200: break
            except OSError:
                if attempt == 29: raise
                time.sleep(2)
        # Public/browser S3 endpoint must preserve signed hosts, Range and sandbox headers.
        Installer.check_public_storage(self)

    def administrator(self):
        self.stage('7/7 管理者アカウントを準備します')
        needs_setup = not self.state.get('complete') or self.args.reset_admin_link
        if not self.state.get('admin_created'):
            # Recover the create/record crash window without creating a second user or elevating an existing one.
            sql = "SELECT row_to_json(t) FROM (SELECT id,username,email,role FROM users WHERE email=:'email') t;"
            existing = self.kube('exec', '-i', 'deployment/postgres', '--', 'psql', '-X', '-q', '-tA', '-U', 'videoq', '-d', 'videoq',
                                 '-v', 'email=' + self.admin['email'], '-f', '-', data=sql, capture=True).strip()
            if existing:
                user = json.loads(existing)
                if user['username'] != self.admin['username'] or 'admin' not in (user.get('role') or '').split(','):
                    raise ValueError('同じメールの既存アカウントが指定した管理者と一致しません。権限を変更しません')
                self.record(admin_provisioning=True)
                recovery = json.loads(self.kube('exec', 'deployment/videoq-api', '--', 'node', 'dist/provision-user.mjs', '--reset', user['id'], capture=True))
                admin = {**user, **recovery}
            else:
                self.record(admin_provisioning=True)
                result = self.kube('exec', 'deployment/videoq-api', '--', 'node', 'dist/provision-user.mjs', '--admin',
                                   '--username', self.admin['username'], '--email', self.admin['email'], capture=True)
                admin = json.loads(result)
            private_json(self.directory / 'admin-setup.json', admin)
            self.record(admin_created=True, admin_provisioning=False, admin_id=admin['id'])
        elif self.args.reset_admin_link:
            admin = json.loads(self.kube('exec', 'deployment/videoq-api', '--', 'node', 'dist/provision-user.mjs', '--reset', self.state['admin_id'], capture=True))
            private_json(self.directory / 'admin-setup.json', admin)
        password_set = False
        if needs_setup and sys.stdin.isatty():
            password = initial_password()
            if password is not None:
                setup = json.loads((self.directory / 'admin-setup.json').read_text())
                activate_admin(self.url, setup['activation_url'], password, getattr(self, 'http_client', None))
                del password
                self.record(admin_password_set=True)
                password_set = True
        print(f'\nVideoQ 起動完了: {self.url}\n管理者: {self.admin["username"]}\n設定・鍵・初回設定リンク: {self.directory}', flush=True)
        if self.url.startswith('http://'):
            print(f'手元のPCで: ssh -N -L {urlsplit(self.url).port}:127.0.0.1:{urlsplit(self.url).port} <SSHホスト名>', flush=True)
        else:
            print('ブラウザで上記のHTTPS URLを開いてください。SSH転送は不要です。', flush=True)
        if password_set:
            print('初回パスワードを設定しました。ブラウザでログインしてください。')
        elif needs_setup:
            print('次の短時間・一度限りのリンクを手元のブラウザで開き、パスワードを設定してください。')
            if sys.stdin.isatty():
                print(json.loads((self.directory / 'admin-setup.json').read_text())['activation_url'], flush=True)
        if self.network['tls_mode'] == 'internal':
            print(f'各利用端末にCA証明書 {self.directory / "tls/root-ca.crt"} を信頼登録してください（秘密鍵は配布しません）。')
        elif self.network['tls_mode'] == 'provided':
            print('持ち込み証明書の更新は自動ではありません。更新後のPEMを指定して同じコマンドを再実行してください。')
        self.record(complete=True, url=self.url, pending_url=None)

    def execute(self):
        self.host(); self.tools(); self.release(); self.ensure_cluster()
        self.inference(); self.backing(); self.application(); self.forwarding(); self.administrator()


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--directory', default=str(Path.home() / '.local/share/videoq-rtx4090'))
    result.add_argument('--url', help='Browser HTTPS origin (default: detected LAN IPv4)')
    result.add_argument('--listen-ip', help='Local IPv4 to bind; does not configure NIC/DHCP (default 0.0.0.0)')
    result.add_argument('--tls-mode', choices=('internal', 'provided', 'acme'), help='Internal CA (default), PEM certificate, or public ACME')
    result.add_argument('--tls-cert', help='PEM certificate including intermediates, for provided mode')
    result.add_argument('--tls-key', help='PEM private key, for provided mode')
    result.add_argument('--tls-ca', help='Optional PEM root CA for installer HTTPS verification')
    result.add_argument('--migrate-url', action='store_true', help='Explicitly migrate public URL/CORS while preserving accounts, keys and data')
    result.add_argument('--username'); result.add_argument('--email')
    result.add_argument('--run-id'); result.add_argument('--source-sha')
    result.add_argument('--storage-gib', type=int)
    result.add_argument('--adopt-existing', action='store_true', help='Use this dedicated host\'s existing native K3s, preserving data')
    result.add_argument('--prepare-only', action='store_true', help=argparse.SUPPRESS)
    result.add_argument('--reset-admin-link', action='store_true', help='Explicitly issue another short-lived setup/recovery link')
    return result


def main():
    try:
        args = parser().parse_args()
        if os.geteuid() == 0:
            raise ValueError('通常ユーザーで実行してください。必要なOS操作だけsudoを使います')
        instance = NativeInstaller(args)
        try:
            if args.prepare_only:
                if instance.host_kubeconfig.exists() and not instance.state.get('cluster_owned') and not args.adopt_existing:
                    raise ValueError('既存K3sへの導入には --adopt-existing が必要です')
                instance.tools()
            else:
                instance.execute()
        finally:
            instance.lock.close()
    except (ValueError, subprocess.CalledProcessError, OSError, EOFError) as error:
        print('導入を停止しました: ' + str(error), file=sys.stderr)
        print('既存データと記録は保持しています。同じコマンドで再開できます。', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
