"""Opt-in K3s/Helm lifecycle checks with real PVCs and PostgreSQL (no public ports)."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('k3s.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
from common import INFRA
from lifecycle import verify_backup


class FixtureInstaller(installer.Installer):
    def tools(self, auth=True):
        super().tools(auth=False)

    def release(self, updating=False):
        # Only the test fixture bypasses GitHub; production has no verification opt-out.
        self.selected_release = {'run_id': '2' if updating else '1', 'run_attempt': 1,
                                 'source_sha': ('b' if updating else 'a') * 40}
        self.chart = self.directory / 'chart'
        self.images = self.directory / 'verified-images.json'

    def finish(self, provision=True):
        self.kube('exec', 'deployment/postgres', '--', 'psql', '-U', 'videoq', '-d', 'videoq',
                  '-c', "SELECT * FROM data_probe WHERE value='retained';")


@unittest.skipUnless(os.environ.get('VIDEOQ_K3S_LIFECYCLE') == '1', 'opt-in K3s lifecycle')
class KubernetesLifecycleTests(unittest.TestCase):
    def test_failed_update_retry_backup_and_both_uninstall_modes(self):
        cluster = 'videoq-lifecycle-' + secrets.token_hex(4)
        with tempfile.TemporaryDirectory(prefix='videoq-k8s-lifecycle-') as temporary:
            directory = Path(temporary) / 'installation'
            args = argparse.Namespace(command='install', directory=str(directory), url='https://videoq.example.com',
                                      cluster=cluster, run_id=None, source_sha=None, backup=None, purge=False, yes=False,
                                      username=None, email=None)
            instance = FixtureInstaller(args)
            instance.tools()
            created = False
            try:
                (directory / 'storage').mkdir()
                with socket.socket() as listener:
                    listener.bind(('127.0.0.1', 0))
                    port = listener.getsockname()[1]
                instance.k3d('cluster', 'create', cluster, '--api-port', '127.0.0.1:' + str(port), '--image', installer.K3S,
                    '--volume', str(directory / 'storage') + ':/var/lib/rancher/k3s/storage@server:0',
                    '--k3s-arg', '--disable=traefik,metrics-server,servicelb@server:0',
                    '--kubeconfig-update-default=false', '--kubeconfig-switch-context=false', '--timeout', '180s')
                created = True
                instance.refresh_kubeconfig()
                instance.apply({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'videoq'}})
                values = installer.new_credentials('fixture-only', instance.url)
                for name, data in values.items():
                    instance.apply({'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': name}, 'stringData': data})
                instance.state = {'cluster': cluster, 'url': instance.url, 'run_id': '1', 'run_attempt': 1,
                                  'source_sha': 'a' * 40, 'admin_created': True}
                instance.save_state()
                self.make_chart(instance)
                instance.release()
                installer.private_json(directory / 'verified-images.json', {})
                for name in ('postgres', 'garage', 'queue', 'caddy'):
                    instance.apply({'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {'name': name + '-data'},
                                    'spec': {'accessModes': ['ReadWriteOnce'], 'resources': {'requests': {'storage': '1Gi'}}}})
                for name in ('postgres', 'garage', 'queue', 'videoq-gateway'):
                    claim = ('caddy' if name == 'videoq-gateway' else name) + '-data'
                    container = {'name': name, 'image': INFRA['postgres'], 'volumeMounts': [{'name': 'data', 'mountPath': '/data'}]}
                    if name == 'postgres':
                        container['volumeMounts'][0]['mountPath'] = '/var/lib/postgresql/data'
                        container['envFrom'] = [{'secretRef': {'name': 'videoq-postgres'}}]
                        container['readinessProbe'] = {'exec': {'command': ['pg_isready', '-U', 'videoq']}, 'periodSeconds': 2}
                    else:
                        container['command'] = ['sh', '-c', 'echo retained > /data/probe; exec sleep 86400']
                    instance.apply({'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': name}, 'spec': {
                        'replicas': 1, 'strategy': {'type': 'Recreate'}, 'selector': {'matchLabels': {'fixture': name}},
                        'template': {'metadata': {'labels': {'fixture': name}}, 'spec': {'terminationGracePeriodSeconds': 5, 'containers': [container],
                        'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': claim}}]}}}})
                instance.apply({'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': 'postgres'},
                                'spec': {'selector': {'fixture': 'postgres'}, 'ports': [{'port': 5432}]}})
                for name in ('postgres', 'garage', 'queue', 'videoq-gateway'):
                    instance.kube('rollout', 'status', 'deployment/' + name, '--timeout=300s')
                instance.kube('exec', 'deployment/postgres', '--', 'psql', '-U', 'videoq', '-d', 'videoq', '-c',
                              "CREATE TABLE data_probe(value text); INSERT INTO data_probe VALUES ('retained');")
                instance.application()
                # A migration really changes SQL state before intentionally failing.
                site = json.loads((directory / 'site-public.json').read_text())
                site['failMigration'] = True
                installer.private_json(directory / 'site-public.json', site)
                instance.args.command = 'update'
                with self.assertRaises(subprocess.CalledProcessError):
                    instance.update()
                self.assertEqual(instance.state['source_sha'], 'a' * 40)
                pending = instance.state['pending_update']
                self.assertEqual(pending['phase'], 'backed_up')
                manifest = verify_backup(pending['backup'])
                self.assertEqual(set(manifest['pvcs']), {'postgres-data', 'garage-data', 'queue-data', 'caddy-data'})
                self.restore_backup_database(instance, Path(pending['backup']))
                deployments = json.loads(instance.kube('get', 'deployments', '-o', 'json', capture=True))['items']
                self.assertTrue(all(d['spec']['replicas'] == 0 for d in deployments if d['metadata']['name'].startswith('videoq-')))
                # Retrying uses the SAME verified backup and keeps the original DB data.
                backup = Path(pending['backup'])
                before = (backup / 'backup.json').read_bytes()
                site['failMigration'] = False
                installer.private_json(directory / 'site-public.json', site)
                instance.update()
                self.assertEqual(instance.state['source_sha'], 'b' * 40)
                self.assertNotIn('pending_update', instance.state)
                self.assertEqual((backup / 'backup.json').read_bytes(), before)
                instance.args.command = 'uninstall'
                instance.uninstall()
                self.assertTrue(instance.state['uninstalled'])
                self.assertTrue((directory / 'storage').exists())
                self.assertTrue((directory / 'installation.json').exists())
                instance.args.purge = True
                instance.args.yes = True
                instance.uninstall()
                created = False
                self.assertFalse(directory.exists())
            finally:
                if created:
                    instance.k3d('cluster', 'delete', cluster)
                if (directory / 'storage').exists():
                    subprocess.run(['sudo', '-n', 'rm', '-r', '--', str(directory / 'storage')], check=True)

    @staticmethod
    def restore_backup_database(instance, backup):
        # Prove the physical snapshot restores the original SQL state on a NEW PVC.
        instance.apply({'apiVersion': 'v1', 'kind': 'PersistentVolumeClaim', 'metadata': {'name': 'restore-check'},
                        'spec': {'accessModes': ['ReadWriteOnce'], 'resources': {'requests': {'storage': '1Gi'}}}})
        instance.apply({'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'restore-archive'}, 'spec': {
            'restartPolicy': 'Never', 'terminationGracePeriodSeconds': 1,
            'containers': [{'name': 'restore', 'image': INFRA['postgres'], 'command': ['sleep', '300'],
                            'securityContext': {'runAsUser': 0},
                            'volumeMounts': [{'name': 'data', 'mountPath': '/restore/postgres-data'}]}],
            'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': 'restore-check'}}]}})
        instance.kube('wait', '--for=condition=Ready', 'pod/restore-archive', '--timeout=180s')
        with (backup / 'volumes.tar.gz').open('rb') as stream:
            subprocess.run(['kubectl', '--kubeconfig', str(instance.kubeconfig), '-n', 'videoq', 'exec', '-i', 'restore-archive',
                            '--', 'tar', '-xzf', '-', '-C', '/restore', './postgres-data'], stdin=stream, check=True)
        instance.kube('delete', 'pod', 'restore-archive', '--wait=true')
        instance.apply({'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'restore-database'}, 'spec': {
            'restartPolicy': 'Never', 'terminationGracePeriodSeconds': 5,
            'containers': [{'name': 'postgres', 'image': INFRA['postgres'],
                'envFrom': [{'secretRef': {'name': 'videoq-postgres'}}],
                'readinessProbe': {'exec': {'command': ['pg_isready', '-U', 'videoq']}, 'periodSeconds': 2},
                'volumeMounts': [{'name': 'data', 'mountPath': '/var/lib/postgresql/data'}]}],
            'volumes': [{'name': 'data', 'persistentVolumeClaim': {'claimName': 'restore-check'}}]}})
        instance.kube('wait', '--for=condition=Ready', 'pod/restore-database', '--timeout=180s')
        result = instance.kube('exec', 'restore-database', '--', 'psql', '-U', 'videoq', '-d', 'videoq', '-At', '-c',
                    "SELECT count(*) FROM data_probe WHERE value='retained'; SELECT to_regclass('migration_probe') IS NULL;", capture=True)
        if result.strip().splitlines() != ['1', 't']:
            raise AssertionError('Restored backup does not match pre-update database state')
        instance.kube('delete', 'pod', 'restore-database', '--wait=true')
        instance.kube('delete', 'pvc', 'restore-check', '--wait=true')

    @staticmethod
    def make_chart(instance):
        chart = instance.directory / 'chart'
        (chart / 'templates').mkdir(parents=True)
        (chart / 'Chart.yaml').write_text('apiVersion: v2\nname: lifecycle-fixture\nversion: 0.1.0\n')
        image = INFRA['postgres']
        deployment = []
        for name in ('api', 'worker', 'web'):
            deployment.append({'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'videoq-' + name},
                'spec': {'replicas': 1, 'selector': {'matchLabels': {'fixture': name}}, 'template': {
                'metadata': {'labels': {'fixture': name}}, 'spec': {'terminationGracePeriodSeconds': 1, 'containers': [{'name': name, 'image': image,
                                                                               'command': ['sleep', '86400']}]}}}})
        (chart / 'templates/app.yaml').write_text('\n---\n'.join(json.dumps(o) for o in deployment))
        (chart / 'templates/migrate.yaml').write_text('''apiVersion: batch/v1
kind: Job
metadata:
  name: fixture-migration
  annotations:
    helm.sh/hook: pre-upgrade
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: IMAGE
          env:
            - name: PGPASSWORD
              valueFrom: {secretKeyRef: {name: videoq-postgres, key: POSTGRES_PASSWORD}}
          command: [sh, -c]
          args:
            - psql -h postgres -U videoq -d videoq -v ON_ERROR_STOP=1 -c 'CREATE TABLE IF NOT EXISTS migration_probe(value text);'; {{ if .Values.failMigration }}exit 9{{ else }}exit 0{{ end }}
'''.replace('IMAGE', image))
