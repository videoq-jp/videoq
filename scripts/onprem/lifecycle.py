"""Cold backups, verified updates and scoped removal of an installer-owned cluster."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

from common import INFRA, private_json

RELEASE_KEYS = ('run_id', 'source_sha', 'run_attempt')
DATA_PVCS = ('postgres-data', 'garage-data', 'queue-data', 'caddy-data')
WRITERS = ('videoq-gateway', 'videoq-api', 'videoq-worker', 'videoq-web')
BACKENDS = ('postgres', 'garage', 'queue')


def checksum(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def verify_backup(directory):
    directory = Path(directory)
    manifest = json.loads((directory / 'backup.json').read_text())
    required = {'volumes.tar.gz', 'credentials.json', 'runtime.json', 'state.json', 'site-public.json'}
    if manifest.get('version') != 1 or not required.issubset(manifest.get('files', {})):
        raise ValueError('バックアップのマニフェストが不完全です')
    for name, digest in manifest['files'].items():
        relative = Path(name)
        if relative.is_absolute() or len(relative.parts) != 1 or name in ('.', '..'):
            raise ValueError('バックアップのファイルパスが不正です')
        path = directory / name
        if path.is_symlink() or not path.is_file() or checksum(path) != digest:
            raise ValueError('バックアップのチェックサムが一致しません: ' + name)
    return manifest


class Lifecycle:
    def save_state(self):
        private_json(self.state_path, self.state)

    def refresh_kubeconfig(self):
        config = self.k3d('kubeconfig', 'get', self.cluster, capture=True)
        with self.kubeconfig.open('w') as stream:
            os.chmod(self.kubeconfig, 0o600)
            stream.write(config)

    def owned_cluster(self, required=True, start=False):
        clusters = json.loads(self.k3d('cluster', 'list', '-o', 'json', capture=True))
        if not any(c['name'] == self.cluster for c in clusters):
            if required:
                raise ValueError('記録したクラスタがありません。install で導入してください')
            return False
        node = 'k3d-' + self.cluster + '-server-0'
        info = json.loads(self.run(*self.docker_prefix, 'docker', 'inspect', node, capture=True))[0]
        expected = str(self.directory / 'storage')
        if not any(m['Destination'] == '/var/lib/rancher/k3s/storage' and m['Source'] == expected for m in info['Mounts']):
            raise ValueError('クラスタの保存先が導入記録と異なります。別環境は操作できません')
        if start and not info['State']['Running']:
            self.k3d('cluster', 'start', self.cluster)
        if start:
            self.refresh_kubeconfig()
        return info['State']['Running'] or start

    def runtime_snapshot(self):
        deployments = json.loads(self.kube('get', 'deployments', '-o', 'json', capture=True))['items']
        found = {d['metadata']['name']: {'replicas': d['spec'].get('replicas', 1),
                                        'selector': d['spec']['selector']['matchLabels']} for d in deployments}
        if not set(WRITERS + BACKENDS).issubset(found):
            raise ValueError('更新に必要なワークロードがありません。install を完了してください')
        cronjobs = json.loads(self.kube('get', 'cronjobs', '-l', 'app.kubernetes.io/instance=videoq', '-o', 'json', capture=True))['items']
        return {'deployments': {n: found[n] for n in WRITERS + BACKENDS},
                'cronjobs': {c['metadata']['name']: c['spec'].get('suspend', False) for c in cronjobs}}

    def wait_empty(self, selector, timeout=1100):
        deadline = time.monotonic() + timeout
        label = ','.join(k + '=' + v for k, v in sorted(selector.items()))
        while json.loads(self.kube('get', 'pods', '-l', label, '-o', 'json', capture=True))['items']:
            if time.monotonic() >= deadline:
                raise ValueError('書き込み Pod の終了待ちがタイムアウトしました: ' + label)
            time.sleep(3)

    def pause_cronjobs(self, wait=True):
        jobs = json.loads(self.kube('get', 'cronjobs', '-l', 'app.kubernetes.io/instance=videoq', '-o', 'json', capture=True))['items']
        for job in jobs:
            self.kube('patch', 'cronjob', job['metadata']['name'], '--type=merge', '-p', '{"spec":{"suspend":true}}')
        if wait:
            self.wait_maintenance()

    def wait_maintenance(self):
        # Already-created maintenance Jobs must finish before the snapshot.
        deadline = time.monotonic() + 660
        while True:
            jobs = json.loads(self.kube('get', 'jobs', '-l', 'app.kubernetes.io/instance=videoq', '-o', 'json', capture=True))['items']
            active = [j for j in jobs if any(o['kind'] == 'CronJob' for o in j['metadata'].get('ownerReferences', []))
                      and j.get('status', {}).get('active', 0)]
            if not active:
                return
            if time.monotonic() >= deadline:
                raise ValueError('保守 Job が終了しません。更新を停止しました')
            time.sleep(3)

    def scale(self, names, replicas, runtime):
        for name in names:
            count = runtime['deployments'][name]['replicas'] if replicas is None else replicas
            self.kube('scale', 'deployment/' + name, '--replicas=' + str(count))
        if replicas == 0:
            for name in names:
                self.wait_empty(runtime['deployments'][name]['selector'])
        else:
            for name in names:
                self.kube('rollout', 'status', 'deployment/' + name, '--timeout=300s')

    def restore_cronjobs(self, runtime):
        for name, suspended in runtime['cronjobs'].items():
            self.kube('patch', 'cronjob', name, '--type=merge', '-p', json.dumps({'spec': {'suspend': suspended}}))

    def quiesce(self, runtime, backends=True):
        self.pause_cronjobs(wait=False)
        self.scale(WRITERS, 0, runtime)
        self.wait_maintenance()
        if backends:
            self.scale(BACKENDS, 0, runtime)

    def cold_backup(self, pending):
        destination = Path(pending['backup'])
        if (destination / 'backup.json').exists():
            verify_backup(destination)
            pending['phase'] = 'backed_up'
            self.save_state()
            self.kube('delete', 'pod', 'videoq-backup-' + pending['id'][:12], '--ignore-not-found=true', '--wait=true')
            return
        if destination.exists():
            marker = destination / '.incomplete'
            if not marker.is_file() or marker.read_text() != pending['id']:
                raise ValueError('バックアップ先が既に存在します。別の --backup を指定してください')
        else:
            destination.mkdir(mode=0o700, parents=True)
            marker = destination / '.incomplete'
            marker.write_text(pending['id'])
            os.chmod(marker, 0o600)
        os.chmod(destination, 0o700)
        volumes = json.loads(self.kube('get', 'pvc', *DATA_PVCS, '-o', 'json', capture=True))['items']
        if len(volumes) != len(DATA_PVCS) or any(v['status']['phase'] != 'Bound' for v in volumes):
            raise ValueError('バックアップ対象の PVC が揃っていません')
        credentials = json.loads(self.kube('get', 'secret', 'videoq-runtime', 'videoq-postgres', 'videoq-garage', '-o', 'json', capture=True))
        private_json(destination / 'credentials.json', credentials)
        private_json(destination / 'runtime.json', pending['runtime'])
        private_json(destination / 'state.json', self.state)
        private_json(destination / 'site-public.json', json.loads((self.directory / 'site-public.json').read_text()))
        pod = 'videoq-backup-' + pending['id'][:12]
        mounts = [{'name': name, 'mountPath': '/snapshot/' + name, 'readOnly': True} for name in DATA_PVCS]
        self.apply({'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': pod}, 'spec': {
            'restartPolicy': 'Never', 'automountServiceAccountToken': False, 'terminationGracePeriodSeconds': 5,
            'containers': [{'name': 'snapshot', 'image': INFRA['postgres'], 'command': ['sleep', '3600'],
                            'securityContext': {'runAsUser': 0}, 'volumeMounts': mounts,
                            'resources': {'requests': {'cpu': '25m', 'memory': '32Mi'}, 'limits': {'memory': '128Mi'}}}],
            'volumes': [{'name': name, 'persistentVolumeClaim': {'claimName': name, 'readOnly': True}} for name in DATA_PVCS]}})
        try:
            self.kube('wait', '--for=condition=Ready', 'pod/' + pod, '--timeout=300s')
            archive = destination / 'volumes.tar.gz'
            with archive.open('wb') as stream:
                os.chmod(archive, 0o600)
                subprocess.run(['kubectl', '--kubeconfig', str(self.kubeconfig), '-n', 'videoq', 'exec', pod, '--',
                                'tar', '-czf', '-', '-C', '/snapshot', '.'], stdout=stream, check=True)
            files = ['volumes.tar.gz', 'credentials.json', 'runtime.json', 'state.json', 'site-public.json']
            plan = self.directory / 'inference-plan.json'
            if plan.exists():
                private_json(destination / 'inference-plan.json', json.loads(plan.read_text()))
                files.append('inference-plan.json')
            private_json(destination / 'backup.json', {'version': 1, 'created_at': datetime.now(timezone.utc).isoformat(),
                'previous': {k: self.state[k] for k in RELEASE_KEYS}, 'target': pending['target'],
                'pvcs': list(DATA_PVCS), 'files': {name: checksum(destination / name) for name in files}})
            verify_backup(destination)
            pending['phase'] = 'backed_up'
            self.save_state()
            marker.unlink()
        finally:
            self.kube('delete', 'pod', pod, '--ignore-not-found=true', '--wait=true')

    def update(self):
        if self.state.get('uninstalled'):
            raise ValueError('アンインストール済みです。install でデータを引き継いで再導入してください')
        self.tools()
        self.stage('更新先のリリースを検証します。検証が終わるまで稼働環境は変更しません')
        self.release(updating=True)
        if all(self.selected_release[k] == self.state.get(k) for k in RELEASE_KEYS) and not self.state.get('pending_update'):
            print('指定したリリースは導入済みです。更新は不要です。')
            return
        self.owned_cluster(start=True)
        self.prepare_inference()
        pending = self.state.get('pending_update')
        if not pending:
            destination = Path(self.args.backup).expanduser().resolve() if self.args.backup else self.directory / 'backups' / (
                datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + secrets.token_hex(4))
            if destination.exists():
                raise ValueError('バックアップ先は新しいディレクトリを指定してください')
            if destination == self.directory or destination in self.directory.parents or self.directory / 'storage' in (destination, *destination.parents):
                raise ValueError('バックアップ先を導入先や稼働データの保存先に重ねることはできません')
            pending = {'id': secrets.token_hex(16), 'target': self.selected_release, 'backup': str(destination),
                       'runtime': self.runtime_snapshot(), 'phase': 'selected'}
            self.state['pending_update'] = pending
            self.save_state()
        elif self.args.backup and Path(self.args.backup).expanduser().resolve() != Path(pending['backup']):
            raise ValueError('再開時は記録済みのバックアップ先を使用してください')
        runtime = pending['runtime']
        backed_up = pending['phase'] == 'backed_up'
        try:
            if not backed_up:
                self.stage('書き込みを停止し、DB・S3・キュー・証明書・鍵をバックアップします')
                self.quiesce(runtime)
                self.cold_backup(pending)
                pending['phase'] = 'backed_up'
                self.save_state()
                backed_up = True
            else:
                verify_backup(pending['backup'])
                self.kube('delete', 'pod', 'videoq-backup-' + pending['id'][:12], '--ignore-not-found=true', '--wait=true')
                self.quiesce(runtime, backends=False)
            self.scale(BACKENDS, None, runtime)
            self.local_inference()
            self.application(replicas=runtime)
            self.restore_cronjobs(runtime)
            self.scale(('videoq-gateway',), None, runtime)
            self.finish(provision=False)
        except BaseException:
            backed_up = backed_up or pending['phase'] == 'backed_up' or (Path(pending['backup']) / 'backup.json').exists()
            if backed_up:
                # Schema may already have changed: never restart old application images.
                try:
                    self.quiesce(runtime, backends=False)
                except Exception as stop_error:
                    print('更新失敗後の停止処理を確認してください: ' + type(stop_error).__name__, flush=True)
                print('更新を停止しました。アプリは再開せず、元のリリースとバックアップを保持します。update を再実行して再開してください。', flush=True)
            else:
                # No target migration has run; returning to the previous runtime is safe.
                self.scale(BACKENDS, None, runtime)
                self.scale(WRITERS, None, runtime)
                self.restore_cronjobs(runtime)
            raise
        self.state.update(self.selected_release)
        self.state.pop('pending_update')
        self.state['last_backup'] = pending['backup']
        self.save_state()
        print('更新完了。更新前バックアップ: ' + pending['backup'], flush=True)

    def validate_purge(self):
        ROOT = Path(__file__).resolve().parents[2]
        protected = (Path('/'), Path.home().resolve(), ROOT.resolve(), Path(sys.prefix).resolve(),
                     Path(os.environ.get('VIDEOQ_TOOLS_DIR', str(Path.home() / '.local/bin'))).resolve())
        if any(self.directory == p or self.directory in p.parents for p in protected):
            raise ValueError('ホーム・リポジトリ・システム・ツールの保存先を削除できません')
        if not self.state_path.is_file() or self.state_path.is_symlink() or not self.state.get('source_sha'):
            raise ValueError('このディレクトリの導入記録を確認できないため削除しません')

    def uninstall(self):
        purge = self.args.purge
        if purge:
            self.validate_purge()
            if not self.args.yes and input(f'データ・鍵・内部バックアップを完全削除します。確認のため {self.cluster} を入力: ').strip() != self.cluster:
                raise ValueError('完全削除を中止しました')
        elif self.state.get('pending_update'):
            raise ValueError('更新が未完了です。update で再開するか、完全削除を選んでください')
        self.tools(auth=False)
        running = self.owned_cluster(required=False, start=not purge and not self.state.get('uninstalled', False))
        exists = any(c['name'] == self.cluster for c in json.loads(self.k3d('cluster', 'list', '-o', 'json', capture=True)))
        if purge:
            if exists:
                self.k3d('cluster', 'delete', self.cluster)
            # Cluster deletion does not remove the host-mounted PVC data.
            storage = self.directory / 'storage'
            if storage.exists() or storage.is_symlink():
                self.run('sudo', '-n', 'rm', '-r', '--', str(storage))
            # Leave the ownership marker until the other private files are removed.
            for child in self.directory.iterdir():
                if child.name in (self.state_path.name, '.operation.lock'):
                    continue
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
            self.state_path.unlink()
            (self.directory / '.operation.lock').unlink(missing_ok=True)
            self.directory.rmdir()
            print('クラスタ・データ・鍵・証明書・設定・内部バックアップを完全削除しました。')
        else:
            if running:
                self.refresh_kubeconfig()
                gateway = self.kube('get', 'deployment', 'videoq-gateway', '--ignore-not-found', '-o', 'json', capture=True)
                if gateway.strip():
                    self.kube('scale', 'deployment/videoq-gateway', '--replicas=0')
                self.run('helm', 'uninstall', 'videoq', '--kubeconfig', str(self.kubeconfig), '-n', 'videoq',
                         '--ignore-not-found', '--wait', '--timeout', '20m')
                if getattr(self, 'ai', 'openrouter') != 'openrouter':
                    self.run('helm', 'uninstall', 'inference', '--kubeconfig', str(self.kubeconfig), '-n', 'videoq',
                             '--ignore-not-found', '--wait', '--timeout', '10m')
                self.k3d('cluster', 'stop', self.cluster)
            self.state['uninstalled'] = True
            self.save_state()
            print('アプリを削除し、クラスタを停止しました。データと鍵は保持しています。install で再導入できます。')
