"""Public Kubernetes entrypoint validation and resume safety."""
import argparse
import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
from unittest.mock import Mock, patch
from lifecycle import checksum, verify_backup

spec = importlib.util.spec_from_file_location('k3s_installer', Path(__file__).with_name('k3s.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class PublicInstallerTests(unittest.TestCase):
    def test_rejects_nonpublic_hosts_and_caddy_injection(self):
        for url in ['http://videoq.example.com', 'https://localhost', 'https://127.0.0.1',
                    'https://10.0.0.1', 'https://example.com:9443', 'https://u:p@example.com',
                    'https://example.com/path', 'https://example.com\nrespond 200',
                    'https://{$HOST}', 'https://bad..example.com', 'https://example.com;foo']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                installer.public_origin(url)
        self.assertEqual(installer.public_origin('https://VIDEOQ.example.com:443/'), 'https://videoq.example.com')
        self.assertEqual(installer.public_origin('https://8.8.8.8'), 'https://8.8.8.8')

    def test_public_media_paths_keep_signature_path_and_sandbox_documents(self):
        config = installer.caddyfile('https://videoq.example.com')
        self.assertIn('@storage path /videoq-media /videoq-media/*', config)
        self.assertIn('reverse_proxy garage:3900', config)
        self.assertNotIn('handle_path', config)  # Stripping the bucket invalidates S3 signatures.
        self.assertIn('Content-Security-Policy "sandbox; default-src', config)
        self.assertIn('default_sni videoq.example.com', config)
        self.assertIn('disable_http_challenge', config)
        self.assertIn('profile shortlived', config)

    def test_host_preparation_never_lowers_existing_limit(self):
        instance = object.__new__(installer.Installer)
        instance.run = Mock()
        setting = Mock()
        setting.exists.return_value = True
        setting.read_text.return_value = '4096'
        with patch.object(installer, 'Path', return_value=setting):
            self.assertFalse(instance.prepare_host())
        instance.run.assert_not_called()

    def test_host_preparation_does_not_overwrite_operator_configuration(self):
        instance = object.__new__(installer.Installer)
        instance.run = Mock()
        setting, config = Mock(), Mock()
        setting.exists.return_value = True
        setting.read_text.return_value = '128'
        config.exists.return_value = True
        config.read_text.return_value = '# operator-owned configuration'
        with patch.object(installer, 'Path', side_effect=[setting, config]), self.assertRaises(ValueError):
            instance.prepare_host()
        instance.run.assert_not_called()

    def test_node_wait_handles_registration_delay_and_transient_api_failure(self):
        instance = object.__new__(installer.Installer)
        instance.kubeconfig = Path('/private/kubeconfig')
        node = 'k3d-videoq-vps-server-0'
        def response(status):
            return subprocess.CompletedProcess([], 0, json.dumps({'items': [{'metadata': {'name': node},
                'status': {'conditions': [{'type': 'Ready', 'status': status}]}}]}), '')
        results = [subprocess.CompletedProcess([], 1, '', 'connection refused'),
                   subprocess.CompletedProcess([], 0, '{"items":[]}', ''), response('False'), response('True')]
        with patch.object(installer.subprocess, 'run', side_effect=results) as run, patch.object(installer.time, 'sleep'):
            instance.wait_node(node)
        self.assertEqual(run.call_count, 4)
        self.assertFalse(any('wait' in c.args[0] for c in run.call_args_list))

    def test_helm_test_retries_transient_service_failure_with_logs(self):
        instance = object.__new__(installer.Installer)
        instance.kubeconfig = Path('/private/kubeconfig')
        instance.run = Mock(side_effect=[subprocess.CalledProcessError(1, ['helm', 'test']), None])
        with patch.object(installer.time, 'sleep'):
            instance.test_application()
        self.assertEqual(instance.run.call_count, 2)
        self.assertIn('--logs', instance.run.call_args.args)

    def test_helm_test_persistent_failure_is_not_ignored(self):
        instance = object.__new__(installer.Installer)
        instance.kubeconfig = Path('/private/kubeconfig')
        instance.run = Mock(side_effect=subprocess.CalledProcessError(1, ['helm', 'test']))
        with patch.object(installer.time, 'sleep'), self.assertRaises(subprocess.CalledProcessError):
            instance.test_application()
        self.assertEqual(instance.run.call_count, 3)

    def test_node_timeout_does_not_delete_cluster(self):
        instance = object.__new__(installer.Installer)
        instance.kubeconfig = Path('/private/kubeconfig')
        with patch.object(installer.subprocess, 'run') as run, self.assertRaisesRegex(ValueError, 'クラスタは保持'):
            instance.wait_node('missing-node', timeout=0)
        run.assert_not_called()

    def test_release_uses_github_sha_without_prompt_and_still_verifies_signature(self):
        sha = 'b' * 40
        with tempfile.TemporaryDirectory() as temporary:
            instance = object.__new__(installer.Installer)
            instance.directory = Path(temporary)
            instance.state_path = instance.directory / 'installation.json'
            instance.state = {}
            instance.cluster, instance.url = 'videoq-vps', 'https://videoq.example.com'
            instance.args = argparse.Namespace(run_id='123', source_sha=None)
            release = instance.directory / 'release/123-attempt-1'
            release.mkdir(parents=True)
            chart = f'videoq-0.1.0-sha.{sha}.tgz'
            (release / 'release.json').write_text(json.dumps({'charts': {'application': {'name': chart}}}))
            for name in [chart, f'videoq-inference-0.1.0-sha.{sha}.tgz']:
                (release / name).write_bytes(b'fixture')
            images = {name: {'image': {'repository': 'ghcr.io/videoq-jp/videoq-' + name, 'digest': 'sha256:' + 'a' * 64}}
                      for name in ['api', 'worker', 'web']}
            (release / 'verified-images.json').write_text(json.dumps(images))
            run = {'conclusion': 'success', 'head_branch': 'main', 'head_sha': sha,
                   'html_url': 'https://github.com/videoq-jp/videoq/actions/runs/123', 'run_attempt': 1}
            instance.run = Mock()
            selected = {'run_id': '123', 'source_sha': sha, 'run_attempt': 1, 'tag': 'onprem-'+sha+'-123-1'}
            with patch('builtins.input', side_effect=AssertionError('SHA prompt must not be used')), patch.object(installer.public_release, 'releases', return_value=[selected]), patch.object(installer.public_release, 'check_run') as check, patch.object(installer.public_release, 'download'):
                instance.release()
            check.assert_called_once_with(selected)
            self.assertEqual(instance.selected_release['source_sha'], sha)
            verify = instance.run.call_args.args
            self.assertNotIn('gh', verify)
            self.assertIn(sha, verify)
            self.assertTrue(str(verify[1]).endswith('onprem_public.py'))

    def test_decodes_kubectl_multiple_documents_and_lists(self):
        raw = '{"kind":"Service"}\n{"kind":"List","items":[{"kind":"Deployment"}]}'
        self.assertEqual([o['kind'] for o in installer.json_documents(raw)], ['Service', 'Deployment'])

    def test_resume_preserves_all_existing_keys_when_changing_origins(self):
        values = installer.new_credentials('test-only', 'http://localhost:18080')
        original_key = values['videoq-runtime']['USER_SECRET_ENCRYPTION_KEY']
        items = [{'metadata': {'name': name}, 'data': {k: base64.b64encode(v.encode()).decode() for k, v in data.items()}}
                 for name, data in values.items()]
        with tempfile.TemporaryDirectory() as temporary:
            instance = object.__new__(installer.Installer)
            instance.directory = Path(temporary)
            instance.url = 'https://videoq.example.com'
            instance.kube = lambda *a, **kw: json.dumps({'items': items})
            applied = []
            instance.apply = applied.append
            with patch.object(installer, 'new_credentials', side_effect=AssertionError('must not regenerate')):
                instance.credentials()
            saved = json.loads((instance.directory / 'credentials.json').read_text())
            self.assertEqual(saved['videoq-runtime']['USER_SECRET_ENCRYPTION_KEY'], original_key)
            self.assertEqual(saved['videoq-garage']['GARAGE_CORS_ORIGINS'], instance.url)
            self.assertEqual((instance.directory / 'credentials.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(applied), 3)

    def test_partial_credentials_fail_before_any_write(self):
        with tempfile.TemporaryDirectory() as temporary:
            instance = object.__new__(installer.Installer)
            instance.directory = Path(temporary)
            instance.url = 'https://videoq.example.com'
            instance.kube = lambda *a, **kw: json.dumps({'items': [{'metadata': {'name': 'videoq-runtime'}, 'data': {}}]})
            instance.apply = lambda *a: self.fail('must not overwrite partial credentials')
            with self.assertRaises(ValueError):
                instance.credentials()
            self.assertFalse((instance.directory / 'credentials.json').exists())

    def test_resume_rejects_switching_recorded_release(self):
        for run_id, sha in [('456', 'a' * 40), ('123', 'b' * 40)]:
            with self.subTest(run_id=run_id, sha=sha), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary) / 'installation.json'
                state.write_text(json.dumps({'url': 'https://videoq.example.com', 'cluster': 'videoq-vps',
                                             'run_id': '123', 'source_sha': 'a' * 40}))
                before = state.read_bytes()
                args = argparse.Namespace(directory=temporary, url='https://videoq.example.com',
                                          cluster='videoq-vps', run_id=run_id, source_sha=sha)
                with self.assertRaises(ValueError):
                    installer.Installer(args)
                self.assertEqual(state.read_bytes(), before)

    def test_release_verification_failure_does_not_mutate_cluster(self):
        with tempfile.TemporaryDirectory() as temporary:
            instance = object.__new__(installer.Installer)
            instance.directory = Path(temporary)
            instance.state = {}
            instance.tools = lambda: None
            instance.release = lambda: (_ for _ in ()).throw(ValueError('signature rejected'))
            instance.ensure_cluster = lambda: self.fail('cluster must not change before verification')
            with self.assertRaisesRegex(ValueError, 'signature rejected'):
                instance.install()


class LocalAITests(unittest.TestCase):
    def test_local_credentials_do_not_request_or_keep_hosted_provider_key(self):
        with tempfile.TemporaryDirectory() as temporary:
            instance = object.__new__(installer.Installer)
            instance.directory = Path(temporary)
            instance.url, instance.ai = 'https://videoq.example.com', 'local-cpu'
            instance.kube = lambda *a, **kw: '{"items":[]}'
            instance.apply = lambda *a: None
            with patch.object(installer.getpass, 'getpass', side_effect=AssertionError('must not ask for OpenRouter')):
                instance.credentials()
            values = json.loads((instance.directory / 'credentials.json').read_text())['videoq-runtime']
            self.assertNotIn('OPENROUTER_API_KEY', values)
            self.assertTrue(values['OPENAI_API_KEY'])

    def test_existing_profile_cannot_be_changed_silently(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / 'installation.json'
            state.write_text(json.dumps({'ai': 'local-cpu'}))
            args = argparse.Namespace(command='install', directory=temporary, ai='local-gpu')
            with self.assertRaisesRegex(ValueError, '再索引'):
                installer.Installer(args)

    def test_resource_quantities_and_init_container_peak(self):
        from local_ai import quantity, pod_requests
        self.assertEqual(quantity('1.5', 'cpu'), 1500)
        self.assertEqual(quantity('2Gi', 'memory'), 2 * 1024**3)
        requests = pod_requests({'containers': [{'resources': {'requests': {'cpu': '100m', 'memory': '1Gi'}}}],
                                'initContainers': [{'resources': {'requests': {'cpu': '2', 'memory': '128Mi'}}}]})
        self.assertEqual(requests['cpu'], 2000)
        self.assertEqual(requests['memory'], 1024**3)

    def capacity_instance(self, directory, mode, memory, gpu):
        instance = object.__new__(installer.Installer)
        instance.directory, instance.ai, instance.cluster = Path(directory), mode, 'videoq-vps'
        instance.ai_plan = [{'kind': 'Deployment', 'spec': {'template': {'spec': {'containers': [
            {'resources': {'requests': {'cpu': '1', 'memory': '8Gi', 'nvidia.com/gpu': 1 if mode == 'local-gpu' else 0}}}
        ]}}}} for _ in range(3)]
        node = {'metadata': {'name': 'k3d-videoq-vps-server-0', 'labels': {'kubernetes.io/arch': 'amd64'}},
                'status': {'allocatable': {'cpu': '16', 'memory': memory, 'nvidia.com/gpu': gpu}}}
        instance.kube = lambda *args, **kw: json.dumps({'items': [node] if args[1] == 'nodes' else []})
        return instance

    def test_small_cpu_host_is_rejected_before_model_deployment(self):
        with tempfile.TemporaryDirectory() as directory:
            instance = self.capacity_instance(directory, 'local-cpu', '4Gi', 0)
            with self.assertRaisesRegex(ValueError, 'memory'):
                instance.check_ai_capacity()

    def test_gpu_recipe_requires_three_allocatable_devices(self):
        with tempfile.TemporaryDirectory() as directory:
            instance = self.capacity_instance(directory, 'local-gpu', '64Gi', 2)
            with self.assertRaisesRegex(ValueError, 'nvidia.com/gpu'):
                instance.check_ai_capacity()
            instance = self.capacity_instance(directory, 'local-gpu', '64Gi', 3)
            instance.check_ai_capacity()

    def test_gpu_mode_does_not_create_a_cpu_only_k3d_node(self):
        instance = object.__new__(installer.Installer)
        instance.ai, instance.cluster = 'local-gpu', 'videoq-vps'
        instance.prepare_host = lambda: False
        instance.k3d = Mock(return_value='[]')
        with self.assertRaisesRegex(ValueError, 'GPU 対応済み'):
            instance.ensure_cluster()
        self.assertEqual(instance.k3d.call_count, 1)

    def test_embedding_weights_change_requires_reindex_but_image_patch_does_not(self):
        from local_ai import embedding_contract
        objects = [{'kind': 'Deployment', 'metadata': {'name': 'videoq-inference-embedding'}, 'spec': {'template': {'spec': {
            'containers': [{'image': 'engine@sha256:old', 'args': ['--pooling', 'last']}],
            'initContainers': [{'image': 'setup@sha256:old', 'env': [{'name': 'MODEL_REVISION', 'value': 'revision-a'}]}]
        }}}}]
        original = embedding_contract(objects)
        objects[0]['spec']['template']['spec']['containers'][0]['image'] = 'engine@sha256:patched'
        self.assertEqual(embedding_contract(objects), original)
        objects[0]['spec']['template']['spec']['initContainers'][0]['env'][0]['value'] = 'revision-b'
        self.assertNotEqual(embedding_contract(objects), original)

    def test_storage_probe_uses_host_network_and_cleans_up_after_failure(self):
        import base64
        instance = object.__new__(installer.Installer)
        probe = {'put': 'https://videoq.example.com/videoq-media/probe?private-signature',
                 'get': 'https://videoq.example.com/videoq-media/probe?private-signature',
                 'payload': base64.b64encode(b'probe').decode(), 'key': 'media/_installer/' + 'a' * 32}
        instance.kube = Mock(side_effect=[json.dumps(probe), None])
        with patch.object(installer, 'urlopen', side_effect=OSError('offline')), self.assertRaisesRegex(ValueError, 'OSError'):
            instance.check_public_storage()
        self.assertIn('--prepare', instance.kube.call_args_list[0].args)
        self.assertIn('--cleanup', instance.kube.call_args_list[1].args)


class LifecycleSafetyTests(unittest.TestCase):
    def test_update_and_uninstall_do_not_create_missing_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / 'missing'
            for command in ('update', 'uninstall'):
                with self.subTest(command=command), self.assertRaises(ValueError):
                    installer.Installer(argparse.Namespace(command=command, directory=str(directory)))
                self.assertFalse(directory.exists())

    def test_update_verification_failure_precedes_cluster_mutation(self):
        instance = object.__new__(installer.Installer)
        instance.state = {}
        instance.tools = lambda: None
        instance.release = lambda **kw: (_ for _ in ()).throw(ValueError('signature rejected'))
        instance.owned_cluster = lambda **kw: self.fail('must not mutate cluster')
        with self.assertRaisesRegex(ValueError, 'signature rejected'):
            instance.update()
        self.assertEqual(instance.state, {})

    def test_install_cannot_bypass_partial_update(self):
        instance = object.__new__(installer.Installer)
        instance.state = {'pending_update': {'phase': 'backed_up'}}
        instance.tools = lambda: self.fail('must not begin install')
        with self.assertRaises(ValueError):
            instance.install()

    def test_purge_rejects_protected_directories(self):
        for directory in (Path('/'), Path.home(), installer.ROOT):
            with self.subTest(directory=directory):
                instance = object.__new__(installer.Installer)
                instance.directory = directory.resolve()
                with self.assertRaises(ValueError):
                    instance.validate_purge()

    def test_canceled_purge_performs_no_operations(self):
        instance = object.__new__(installer.Installer)
        instance.args = argparse.Namespace(purge=True, yes=False)
        instance.cluster = 'videoq-vps'
        instance.validate_purge = lambda: None
        instance.tools = lambda **kw: self.fail('must not run after canceled confirmation')
        with patch('builtins.input', return_value='cancel'), self.assertRaises(ValueError):
            instance.uninstall()

    def test_cluster_with_different_storage_is_never_touched(self):
        instance = object.__new__(installer.Installer)
        instance.directory = Path('/tmp/owned-installation')
        instance.cluster = 'videoq-vps'
        instance.docker_prefix = []
        instance.k3d = lambda *a, **kw: json.dumps([{'name': 'videoq-vps'}]) if a == ('cluster', 'list', '-o', 'json') else self.fail('must not edit cluster')
        instance.run = lambda *a, **kw: json.dumps([{'Mounts': [{'Source': '/other/storage', 'Destination': '/var/lib/rancher/k3s/storage'}]}])
        with self.assertRaises(ValueError):
            instance.owned_cluster(start=True)

    def test_normal_uninstall_never_deletes_cluster_or_data(self):
        instance = object.__new__(installer.Installer)
        instance.args = argparse.Namespace(purge=False)
        instance.state = {}
        instance.cluster = 'videoq-vps'
        instance.kubeconfig = Path('/private/kubeconfig')
        operations = []
        instance.tools = lambda **kw: None
        instance.owned_cluster = lambda **kw: True
        instance.refresh_kubeconfig = lambda: None
        instance.kube = lambda *a, **kw: '{}'
        instance.run = lambda *a, **kw: operations.append(a)
        def k3d(*args, **kwargs):
            operations.append(args)
            return json.dumps([{'name': 'videoq-vps'}]) if args[1] == 'list' else ''
        instance.k3d = k3d
        instance.save_state = lambda: None
        instance.uninstall()
        self.assertTrue(instance.state['uninstalled'])
        self.assertIn(('cluster', 'stop', 'videoq-vps'), operations)
        self.assertFalse(any('delete' in op or 'rm' in op for op in operations))

    def test_backup_corruption_and_traversal_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = ('volumes.tar.gz', 'credentials.json', 'runtime.json', 'state.json', 'site-public.json')
            for name in files:
                (root / name).write_bytes(b'fixture')
            manifest = {'version': 1, 'files': {name: checksum(root / name) for name in files}}
            (root / 'backup.json').write_text(json.dumps(manifest))
            verify_backup(root)
            (root / 'volumes.tar.gz').write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                verify_backup(root)
            manifest['files']['../outside'] = 'a' * 64
            (root / 'volumes.tar.gz').write_bytes(b'fixture')
            (root / 'backup.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                verify_backup(root)


if __name__ == '__main__':
    unittest.main()
