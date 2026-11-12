"""Exercise compiled charts and credential preservation without a GPU or live cluster."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import promote as m


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, m.ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c = load('credentials', 'infra/ansible/roles/lab/files/credentials.py')
p = load('platform_pins', 'infra/ansible/filter_plugins/platform_pins.py')


class CredentialsTests(unittest.TestCase):
    def setUp(self):
        self.key = c.Fernet.generate_key()

    def initialize(self, *args):
        return c.initialize(*args, encryption_key=self.key)

    def state(self, path):
        return json.loads(c.Fernet(self.key).decrypt(path.read_bytes()))

    def test_backup_is_encrypted_and_wrong_keys_or_tampering_never_write_to_the_cluster(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials.enc'
            cluster = {}
            run, calls = self.cluster(cluster)
            self.initialize(path, 'https://192.168.1.50', run)
            state = self.state(path)
            self.assertNotIn(state['secrets']['videoq-postgres']['POSTGRES_PASSWORD'].encode(), path.read_bytes())
            calls.clear()
            with self.assertRaises(c.InvalidToken):
                c.initialize(path, 'https://192.168.1.50', run, encryption_key=c.Fernet.generate_key())
            self.assertTrue(all(args[0] == 'get' for args, _ in calls))
            raw = path.read_bytes()
            path.write_bytes(raw[:-5] + b'xxxxx')
            calls.clear()
            with self.assertRaises(c.InvalidToken):
                self.initialize(path, 'https://192.168.1.50', run)
            self.assertTrue(all(args[0] == 'get' for args, _ in calls))

    def test_explicit_import_preserves_live_keys_and_rejects_a_conflicting_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'original-state.json'
            cluster = {}
            run, calls = self.cluster(cluster)
            fixture = {name: {key: 'unit-test-placeholder' for key in keys} for name, keys in c.KEYS.items()}
            fixture['videoq-garage']['GARAGE_CORS_ORIGINS'] = 'https://192.168.1.50'
            with patch.object(c, 'generate', return_value=fixture):
                self.initialize(path, 'https://192.168.1.50', run)
            source = root / 'native-credentials.json'
            source.write_text(json.dumps(fixture))
            source.chmod(0o600)
            new_state = root / 'ansible-state.json'
            calls.clear()
            self.assertFalse(self.initialize(new_state, 'https://192.168.1.50', run, source))
            self.assertEqual(self.state(new_state)['secrets'], json.loads(source.read_text()))
            self.assertTrue(all(args[0] == 'get' for args, _ in calls))
            conflict = json.loads(source.read_text())
            conflict['videoq-runtime']['BETTER_AUTH_SECRET'] = 'different-key'
            source.write_text(json.dumps(conflict))
            with self.assertRaisesRegex(ValueError, 'differ'):
                self.initialize(root / 'conflict.json', 'https://192.168.1.50', run, source)
            self.assertFalse((root / 'conflict.json').exists())

    def cluster(self, state):
        calls = []
        def run(*args, data=None):
            calls.append((args, data))
            if args[0] == 'get':
                return copy.deepcopy(state.get(args[2]))
            if args[0] == 'create':
                name = data['metadata']['name']
                self.assertNotIn(name, state)
                state[name] = {'data': {key: base64.b64encode(value.encode()).decode() for key, value in data['stringData'].items()}}
                return {}
            self.fail('Unexpected credential operation')
        return run, calls

    def test_rerun_and_partial_install_preserve_the_original_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials.json'
            cluster = {}
            run, calls = self.cluster(cluster)
            self.assertTrue(self.initialize(path, 'https://192.168.1.50', run))
            original = path.read_bytes()
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(self.initialize(path, 'https://192.168.1.50', run))
            del cluster['videoq-runtime']
            self.assertTrue(self.initialize(path, 'https://192.168.1.50', run))
            self.assertEqual(path.read_bytes(), original)
            self.assertTrue(all(args[0] in ('get', 'create') for args, _ in calls))

    def test_a_conflicting_live_key_prevents_all_writes_including_missing_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials.json'
            cluster = {}
            run, calls = self.cluster(cluster)
            self.initialize(path, 'https://192.168.1.50', run)
            del cluster['videoq-runtime']
            cluster['videoq-garage']['data']['GARAGE_SECRET_ACCESS_KEY'] = base64.b64encode(b'changed').decode()
            calls.clear()
            with self.assertRaisesRegex(ValueError, 'differ'):
                self.initialize(path, 'https://192.168.1.50', run)
            self.assertTrue(all(args[0] == 'get' for args, _ in calls))
            path.unlink()
            with self.assertRaisesRegex(ValueError, 'no matching host backup'):
                self.initialize(path, 'https://192.168.1.50', run)


class ManifestTests(unittest.TestCase):
    def test_promotions_protect_the_previous_site_generation_without_private_configuration(self):
        images = {name: {'repository': 'ghcr.io/videoq-jp/videoq-' + name, 'digest': 'sha256:' + 'a'*64}
                  for name in ('api', 'worker', 'web', 'transcription-gateway')}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'site.json'
            first = {'sourceSha': 'a'*40, 'images': images}
            path.write_text(json.dumps(m.deployment_pin(path, first, '123', 1)))
            second = {'sourceSha': 'b'*40, 'images': images}
            promoted = m.deployment_pin(path, second, '124', 1)
            self.assertEqual([g['sourceSha'] for g in promoted['generations']], ['b'*40, 'a'*40])
            path.write_text(json.dumps(promoted))
            self.assertEqual(m.deployment_pin(path, second, '124', 1), promoted)
            third = {'sourceSha': 'c'*40, 'images': images}
            self.assertEqual([g['sourceSha'] for g in m.deployment_pin(path, third, '125', 1)['generations']], ['c'*40, 'b'*40])

    def test_ansible_renders_only_restricted_projects_and_a_manual_root_application(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'bootstrap.yaml'
            playbook = Path(temporary) / 'render.yml'
            import yaml
            playbook.write_text(yaml.safe_dump([{'hosts': 'all', 'connection': 'local', 'become': False,
                'gather_facts': False, 'vars': {
                    'ansible_python_interpreter': sys.executable,
                    'videoq_gitops_repository': 'git@github.com:example/lab-config.git',
                    'videoq_gitops_revision': 'main', 'videoq_gitops_path': 'clusters/lab/apps'},
                'tasks': [{'name': 'Render the actual bootstrap template', 'ansible.builtin.template': {
                    'src': str(m.ROOT / 'infra/ansible/roles/lab/templates/bootstrap.yaml.j2'),
                    'dest': str(output), 'mode': '0600'}}]}]))
            subprocess.run([str(Path(sys.executable).with_name('ansible-playbook')), '-i', 'localhost,', str(playbook)],
                           check=True, capture_output=True)
            objects = list(yaml.safe_load_all(output.read_text()))
        projects = {item['metadata']['name']: item for item in objects if item['kind'] == 'AppProject'}
        for project in projects.values():
            self.assertEqual(project['spec']['clusterResourceWhitelist'], [])
            self.assertNotIn('*', project['spec']['sourceRepos'])
        self.assertEqual(projects['lab-bootstrap']['spec']['namespaceResourceWhitelist'],
                         [{'group': 'argoproj.io', 'kind': 'Application'}])
        root = next(item for item in objects if item['kind'] == 'Application')
        self.assertNotIn('automated', root['spec']['syncPolicy'])
        self.assertNotIn('directory', root['spec']['source'])
        self.assertNotIn('finalizers', root['metadata'])

    def test_upstream_checksum_and_exact_image_inventory_are_enforced(self):
        raw = json.dumps({'apiVersion': 'apps/v1', 'kind': 'Deployment',
            'metadata': {'labels': {'app.kubernetes.io/instance': 'videoq'}},
            'spec': {'template': {'spec': {'containers': [{'image': 'upstream:v1'}]}}}})
        raw += '\n---\n' + json.dumps({'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'argocd-cm'}})
        pin = {'sha256': hashlib.sha256(raw.encode()).hexdigest(), 'images': {'upstream:v1': 'upstream@sha256:' + 'a'*64}}
        result = json.loads(p.pin_argocd_manifest(raw, pin))
        self.assertEqual(result['items'][0]['spec']['template']['spec']['containers'][0]['image'], pin['images']['upstream:v1'])
        self.assertEqual(result['items'][0]['metadata']['labels']['app.kubernetes.io/instance'], 'videoq')
        self.assertEqual(result['items'][1]['data']['application.resourceTrackingMethod'], 'annotation')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            p.pin_argocd_manifest(raw + '\n', pin)
        pin['images'] = {'other:v1': 'other@sha256:' + 'b'*64}
        with self.assertRaisesRegex(ValueError, 'Unreviewed'):
            p.pin_argocd_manifest(raw, pin)

    def test_unreviewed_hooks_and_unpinned_images_cannot_be_promoted(self):
        with self.assertRaisesRegex(ValueError, 'unreviewed Helm hook'):
            m.order({'kind': 'Job', 'metadata': {'name': 'surprise', 'annotations': {'helm.sh/hook': 'pre-install'}}}, 0)
        with self.assertRaisesRegex(ValueError, 'digest'):
            m.validate_resources([{'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': 'app'},
                'spec': {'template': {'spec': {'containers': [{'image': 'image:latest'}]}}}}])
        app = m.application('lab-videoq', 'videoq-lab', 'https://github.com/example/config.git', 'main', 'clusters/lab/videoq', 'videoq')
        self.assertNotIn('automated', app['spec']['syncPolicy'])
        self.assertNotIn('finalizers', app['metadata'])

    def test_real_helm_render_preserves_data_orders_migration_and_limits_https_to_lan(self):
        helm = os.environ.get('HELM_BIN', 'helm')
        fixture = json.loads((m.ROOT / '.github/scripts/fixtures/onprem-public/release.json').read_text())
        # Reuse real published image references; these local chart packages are
        # unsigned UNIT fixtures, never accepted by the production promotion CLI.
        fixture['images'].pop('vllm-engine')
        fixture['schemaVersion'] = 5
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for kind, chart in [('application', 'videoq'), ('inference', 'videoq-inference')]:
                subprocess.run([helm, 'package', str(m.ROOT / 'charts' / chart), '--destination', str(directory), '--version', '0.1.0'],
                               check=True, capture_output=True)
                fixture['charts'][kind]['name'] = chart + '-0.1.0.tgz'
            values = m.public_release.public_verifier.manifest.helm_values(fixture)
            objects = m.compile_videoq(directory, fixture, values, 'https://192.168.1.50', 40, '192.168.1.50')
        by_name = {item['metadata']['name']: item for item in objects}
        for name in ('chat', 'embedding', 'whisper'):
            deployment = by_name['videoq-inference-' + name]
            pod = deployment['spec']['template']['spec']
            startup = max(c.get('startupProbe', {}).get('periodSeconds', 10) *
                          c.get('startupProbe', {}).get('failureThreshold', 0)
                          for c in pod['containers'])
            waits = [re.search(r'deadline = time.monotonic\(\) \+ (\d+)',
                     '\n'.join(c.get('command', []) + c.get('args', [])))
                     for c in pod.get('initContainers', []) if c['name'].startswith('wait-for-')]
            self.assertTrue(all(waits), 'Every serialized startup wait must have an inspected bound')
            peer_wait = sum(int(match[1]) for match in waits)
            self.assertGreater(deployment['spec']['progressDeadlineSeconds'], startup + peer_wait,
                               'Cold downloads need time in addition to peer waits and startup probes')
        migration = by_name['videoq-migrate']['metadata']['annotations']
        self.assertEqual(migration['argocd.argoproj.io/hook'], 'Sync')
        self.assertEqual(migration['argocd.argoproj.io/sync-wave'], '20')
        self.assertFalse(any(key.startswith('helm.sh/hook') for key in migration))
        for item in objects:
            self.assertNotEqual(item['kind'], 'Secret')
            if item['kind'] == 'PersistentVolumeClaim':
                self.assertEqual(item['metadata']['annotations']['argocd.argoproj.io/sync-options'], 'Prune=false,Delete=false')
        self.assertEqual(by_name['videoq-api']['metadata']['annotations']['argocd.argoproj.io/sync-wave'], '30')
        self.assertEqual(by_name['postgres']['metadata']['annotations']['argocd.argoproj.io/sync-wave'], '0')
        # WaitForFirstConsumer claims must be created with their first Pod.
        # An earlier Pending claim blocks Argo before it creates that Pod;
        # a later claim leaves the Pod Pending and blocks its own creation.
        consumers = {}
        for item in objects:
            pod = item.get('spec', {}).get('template', {}).get('spec', {})
            for volume in pod.get('volumes', []):
                claim = volume.get('persistentVolumeClaim', {}).get('claimName')
                if claim:
                    consumers.setdefault(claim, []).append(int(item['metadata']['annotations']['argocd.argoproj.io/sync-wave']))
        for item in objects:
            if item['kind'] == 'PersistentVolumeClaim':
                name = item['metadata']['name']
                self.assertIn(name, consumers)
                self.assertEqual(int(item['metadata']['annotations']['argocd.argoproj.io/sync-wave']), min(consumers[name]), name)
        gateway = next(item for item in objects if item['kind'] == 'Deployment' and item['metadata']['name'] == 'videoq-gateway')
        port = gateway['spec']['template']['spec']['containers'][0]['ports'][0]
        self.assertEqual((port['hostIP'], port['hostPort']), ('192.168.1.50', 443))
        serialized = json.dumps(objects)
        self.assertIn('TORCHDYNAMO_DISABLE', serialized)
        self.assertIn('FLEX_ATTENTION', serialized)
        self.assertIn('embeddinggemma-2-f9972ac', serialized)


if __name__ == '__main__':
    unittest.main()
