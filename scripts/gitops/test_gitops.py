"""Exercise compiled charts and credential preservation without a GPU or live cluster."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import os
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
            self.assertTrue(c.initialize(path, 'https://192.168.1.50', run))
            original = path.read_bytes()
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(c.initialize(path, 'https://192.168.1.50', run))
            del cluster['videoq-runtime']
            self.assertTrue(c.initialize(path, 'https://192.168.1.50', run))
            self.assertEqual(path.read_bytes(), original)
            self.assertTrue(all(args[0] in ('get', 'create') for args, _ in calls))

    def test_a_conflicting_live_key_prevents_all_writes_including_missing_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credentials.json'
            cluster = {}
            run, calls = self.cluster(cluster)
            c.initialize(path, 'https://192.168.1.50', run)
            del cluster['videoq-runtime']
            cluster['videoq-garage']['data']['GARAGE_SECRET_ACCESS_KEY'] = base64.b64encode(b'changed').decode()
            calls.clear()
            with self.assertRaisesRegex(ValueError, 'differ'):
                c.initialize(path, 'https://192.168.1.50', run)
            self.assertTrue(all(args[0] == 'get' for args, _ in calls))
            path.unlink()
            with self.assertRaisesRegex(ValueError, 'no matching host backup'):
                c.initialize(path, 'https://192.168.1.50', run)


class ManifestTests(unittest.TestCase):
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
        self.assertNotIn('finalizers', root['metadata'])

    def test_upstream_checksum_and_exact_image_inventory_are_enforced(self):
        raw = json.dumps({'apiVersion': 'apps/v1', 'kind': 'Deployment',
            'spec': {'template': {'spec': {'containers': [{'image': 'upstream:v1'}]}}}})
        pin = {'sha256': hashlib.sha256(raw.encode()).hexdigest(), 'images': {'upstream:v1': 'upstream@sha256:' + 'a'*64}}
        result = json.loads(p.pin_argocd_manifest(raw, pin))
        self.assertEqual(result['items'][0]['spec']['template']['spec']['containers'][0]['image'], pin['images']['upstream:v1'])
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
        gateway = next(item for item in objects if item['kind'] == 'Deployment' and item['metadata']['name'] == 'videoq-gateway')
        port = gateway['spec']['template']['spec']['containers'][0]['ports'][0]
        self.assertEqual((port['hostIP'], port['hostPort']), ('192.168.1.50', 443))
        serialized = json.dumps(objects)
        self.assertIn('TORCHDYNAMO_DISABLE', serialized)
        self.assertIn('FLEX_ATTENTION', serialized)
        self.assertIn('embeddinggemma-2-f9972ac', serialized)


if __name__ == '__main__':
    unittest.main()
