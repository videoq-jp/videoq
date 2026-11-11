"""Native installer safety, resume and real chart invariants (not blank-VM acceptance)."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import rtx4090 as module
from native import application_values, backing_plan, gateway_config, local_origin, model_contract, forwarding_units, browser_origin


class NativeTests(unittest.TestCase):
    def args(self, directory, *extra):
        return module.parser().parse_args(['--directory', str(directory), '--username', 'yuki', '--email', 'yuki@example.com', '--url', 'http://localhost:8080', *extra])

    def instance(self, directory, *extra):
        instance = module.NativeInstaller(self.args(directory, *extra))
        self.addCleanup(instance.lock.close)
        return instance

    def test_interactive_admin_defaults_and_validation(self):
        ask = Mock(side_effect=['', 'Person@example.com'])
        self.assertEqual(module.admin_details(None, None, ask), {'username': 'site_admin', 'email': 'person@example.com'})
        self.assertEqual(ask.call_count, 2)
        for username, email in [('aa', 'a@b.com'), ('x;reboot', 'a@b.com'), ('good_user', 'a@b.com\nextra'), ('good_user', 'missing')]:
            with self.subTest(username=username), self.assertRaises(ValueError):
                module.admin_details(username, email)

    def test_bad_first_input_can_be_corrected_by_the_same_command(self):
        with tempfile.TemporaryDirectory() as folder:
            args = self.args(folder, '--email', 'wrong')
            with self.assertRaises(ValueError): module.NativeInstaller(args)
            instance = self.instance(folder)
            self.assertEqual(instance.admin['username'], 'yuki')

    def test_only_loopback_browser_origin_is_accepted(self):
        self.assertEqual(local_origin('http://LOCALHOST:8080/'), 'http://localhost:8080')
        for url in ['http://example.com:8080', 'https://localhost:8080', 'http://localhost:80', 'http://localhost:8080/path', 'http://localhost:8080\nrespond 200']:
            with self.subTest(url=url), self.assertRaises(ValueError): local_origin(url)
        config = gateway_config('http://localhost:8080')
        self.assertIn('@storage path /videoq-media /videoq-media/*', config)
        self.assertNotIn('handle_path', config)
        self.assertIn('flush_interval -1', config)
        values = application_values('http://localhost:8080')
        self.assertEqual(values['storage']['endpoint'], values['publicUrl'])
        self.assertFalse(values['ingress']['enabled'])

    def test_system_and_repository_directories_are_rejected_before_chmod(self):
        for folder in ['/', '/root', '/etc/videoq', '/root/.ssh/videoq', str(module.ROOT / 'private-runtime')]:
            with self.subTest(folder=folder), patch.object(module.os, 'chmod') as chmod:
                with self.assertRaises(ValueError):
                    module.NativeInstaller(self.args(folder))
                chmod.assert_not_called()

    def test_lock_is_acquired_before_state_is_rewritten(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            before = instance.state_path.read_bytes()
            with self.assertRaisesRegex(ValueError, '実行中'):
                module.NativeInstaller(self.args(folder))
            self.assertEqual(instance.state_path.read_bytes(), before)
            self.assertEqual(os.stat(instance.state_path).st_mode & 0o777, 0o600)

    def test_resume_retains_admin_and_rejects_identity_release_and_storage_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            instance.record(run_id='123', source_sha='a' * 40, admin_created=True)
            instance.lock.close()
            resumed = self.instance(folder)
            self.assertEqual(resumed.admin, instance.admin)
            resumed.lock.close()
            for options in [('--username', 'another'), ('--url', 'http://localhost:9000'), ('--run-id', '456'), ('--source-sha', 'b' * 40), ('--storage-gib', '100')]:
                with self.subTest(options=options), self.assertRaises(ValueError):
                    self.instance(folder, *options)

    def test_unknown_credential_directory_is_not_silently_adopted(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'unrelated').write_text('keep')
            with self.assertRaisesRegex(ValueError, '既存ディレクトリ'):
                self.instance(folder)
            self.assertEqual(Path(folder, 'unrelated').read_text(), 'keep')

    def test_credential_rerun_does_not_regenerate_or_rotate_live_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            values = {name: {'KEY': 'retained'} for name in ('videoq-runtime', 'videoq-postgres', 'videoq-garage')}
            module.private_json(instance.directory / 'credentials.json', values)
            instance.kube = Mock(return_value=json.dumps({'data': {'KEY': base64.b64encode(b'retained').decode()}}))
            instance.apply = Mock()
            with patch.object(module, 'new_credentials') as generate:
                instance.credentials()
                generate.assert_not_called()
            self.assertEqual(instance.apply.call_count, 3)
            instance.kube.return_value = json.dumps({'data': {'KEY': base64.b64encode(b'rotated').decode()}})
            instance.apply.reset_mock()
            with self.assertRaisesRegex(ValueError, '鍵を変更しません'):
                instance.credentials()
            instance.apply.assert_not_called()

    def test_missing_credentials_never_overwrite_existing_runtime_secret(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            instance.kube = Mock(return_value='secret/videoq-runtime')
            instance.apply = Mock()
            with self.assertRaisesRegex(ValueError, '自動生成し直しません'):
                instance.credentials()
            instance.apply.assert_not_called()

    def test_tool_check_works_without_gh_or_login_when_verifier_is_ready(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            instance.run = Mock()
            with patch.object(module.shutil, 'which', side_effect=lambda name: '/usr/bin/helm' if name == 'helm' else None), patch.object(module.public_release, 'verifier_ready', return_value=True), patch.object(module.subprocess, 'run', side_effect=AssertionError('must not run GitHub auth')):
                instance.tools()
            instance.run.assert_not_called()

    def test_release_selects_compatible_success_then_still_runs_signature_verifier(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            instance.run = Mock(return_value=json.dumps([{'databaseId': 1, 'headSha': 'a' * 40}, {'databaseId': 2, 'headSha': 'b' * 40}]))
            instance.runtime_matches = Mock(side_effect=[False, True, True])
            def verified(_): instance.state['source_sha'] = 'b' * 40
            with patch.object(module.Installer, 'release', side_effect=verified) as verifier, patch.object(module.public_release, 'releases', return_value=[{'run_id': '1', 'source_sha': 'a' * 40}, {'run_id': '2', 'source_sha': 'b' * 40}]):
                instance.release()
            verifier.assert_called_once_with(instance)
            self.assertEqual(instance.args.run_id, '2')

    def test_explicit_source_sha_filters_public_release_selection(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder, '--source-sha', 'b' * 40)
            instance.runtime_matches = Mock(return_value=True)
            choices = [{'run_id': '2', 'source_sha': 'a' * 40}, {'run_id': '1', 'source_sha': 'b' * 40}]
            with patch.object(module.Installer, 'release', side_effect=lambda _: instance.state.update(source_sha='b'*40)), patch.object(module.public_release, 'releases', return_value=choices):
                instance.release()
            self.assertEqual(instance.args.run_id, '1')
            self.assertTrue(all(call.args[0] == 'b'*40 for call in instance.runtime_matches.call_args_list))

    def test_inference_contract_change_stops_before_applying_helm(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            instance.state['embedding_contract'] = 'old'
            instance.embedding_digest = 'sha256:' + 'a' * 64
            instance.inference_images = instance.directory / 'verified-inference.json'
            instance.run = Mock(return_value='rendered')
            instance.apply = Mock()
            plan = [{'kind': 'Deployment', 'metadata': {'name': 'videoq-inference-embedding'}, 'spec': {'template': {'spec': {'containers': [{'env': [{'name': 'MODEL', 'value': 'changed'}]}]}}}}]
            instance.kube = Mock(return_value=json.dumps({'kind': 'List', 'items': plan}))
            with self.assertRaisesRegex(ValueError, '埋め込みモデル'):
                instance.inference()
            self.assertFalse(any('upgrade' in call.args for call in instance.run.call_args_list))
            self.assertEqual(instance.state['embedding_contract'], 'old')

    def test_admin_recorded_rerun_never_reissues_link_or_creates_user(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            instance.state.update(admin_created=True, complete=True, admin_id='admin1')
            instance.kube = Mock()
            with contextlib.redirect_stdout(io.StringIO()): instance.administrator()
            instance.kube.assert_not_called()

    def test_admin_crash_window_recovers_same_admin_without_duplicate_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            instance.kube = Mock(side_effect=[json.dumps({'id': 'same', 'username': 'yuki', 'email': 'yuki@example.com', 'role': 'admin'}), json.dumps({'activation_url': 'http://localhost:8080/setup'})])
            with contextlib.redirect_stdout(io.StringIO()): instance.administrator()
            self.assertEqual(instance.state['admin_id'], 'same')
            self.assertIn('--reset', instance.kube.call_args.args)
            self.assertNotIn('--admin', instance.kube.call_args.args)

    def test_existing_nonadmin_is_never_elevated_by_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            instance.kube = Mock(return_value=json.dumps({'id': 'same', 'username': 'yuki', 'email': 'yuki@example.com', 'role': 'user'}))
            with self.assertRaisesRegex(ValueError, '権限を変更しません'): instance.administrator()
            self.assertEqual(instance.kube.call_count, 1)
            self.assertFalse(instance.state.get('admin_created'))

    def test_live_kubernetes_omitted_empty_values_preserve_model_identity(self):
        import copy
        plan = [{'kind': 'Deployment', 'metadata': {'name': 'videoq-inference-embedding'}, 'spec': {'template': {'spec': {'containers': [{'env': [{'name': 'DEVICE', 'value': 'cuda'}]}], 'initContainers': [{'env': [{'name': 'MODEL_REVISION', 'value': 'a' * 40}, {'name': 'MODEL_FILE', 'value': ''}]}]}}}}]
        live = copy.deepcopy(plan)
        del live[0]['spec']['template']['spec']['initContainers'][0]['env'][1]['value']
        self.assertEqual(model_contract(plan), model_contract(live))
        live[0]['spec']['template']['spec']['initContainers'][0]['env'][0]['value'] = 'b' * 40
        self.assertNotEqual(model_contract(plan), model_contract(live))

    def test_password_dialog_retries_without_echo_and_allows_browser_handoff(self):
        ask = Mock(side_effect=['short', 'good-password-123', 'different-password', 'good-password-123', 'good-password-123'])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(module.initial_password(ask), 'good-password-123')
        self.assertNotIn('good-password', out.getvalue())
        self.assertIsNone(module.initial_password(Mock(return_value='')))

    def test_password_is_posted_only_to_own_loopback_api_not_saved_or_printed(self):
        from unittest.mock import MagicMock
        opener = MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.status = 200
        response.read.return_value = b'{"status":true}'
        url = 'http://localhost:8080'
        token = 'a' * 24
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            module.activate_admin(url, url + '/api/auth/reset-password/' + token, 'good-password-123', opener)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, url + '/api/auth/reset-password')
        self.assertEqual(json.loads(request.data), {'token': token, 'newPassword': 'good-password-123'})
        self.assertEqual(out.getvalue(), '')
        opener.reset_mock()
        with self.assertRaises(ValueError):
            module.activate_admin(url, 'https://evil.example/api/auth/reset-password/' + token, 'good-password-123', opener)
        opener.open.assert_not_called()

    def test_private_forwarding_uses_only_loopback_and_validated_cluster_ip(self):
        units = forwarding_units(8080, '10.43.0.20')
        self.assertIn('ListenStream=127.0.0.1:8080', units['videoq-port-forward.socket'])
        self.assertIn('systemd-socket-proxyd 10.43.0.20:8080', units['videoq-port-forward.service'])
        self.assertNotIn('kubectl', units['videoq-port-forward.service'])
        for ip in ['evil.example', '10.0.0.1;reboot', '10.0.0.1\nExecStart=/bin/sh']:
            with self.assertRaises(ValueError): forwarding_units(8080, ip)
        for port in [80, 65536, '8080;reboot']:
            with self.assertRaises(ValueError): forwarding_units(port, '10.43.0.20')

    def test_operator_commands_stay_unprivileged_and_os_operations_use_sudo(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            instance.run = Mock()
            instance.kube('get', 'pods')
            self.assertEqual(instance.run.call_args.args[0], 'k3s')
            self.assertIn(instance.directory / 'kubeconfig', instance.run.call_args.args)
            self.assertNotIn('sudo', instance.run.call_args.args)
            instance.system('docker', 'info')
            self.assertEqual(instance.run.call_args.args, ('sudo', '--', 'docker', 'info'))

    def test_kubeconfig_copy_is_user_private_and_never_changes_host_file_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            instance = self.instance(folder)
            instance.system = Mock(return_value='apiVersion: v1\nprivate-user-config: true\n')
            instance.refresh_kubeconfig()
            self.assertEqual(instance.kubeconfig.parent, instance.directory)
            self.assertEqual(os.stat(instance.kubeconfig).st_mode & 0o777, 0o600)
            instance.system.assert_called_once_with('cat', instance.host_kubeconfig, capture=True)
            instance.run = Mock()
            instance.refresh_kubeconfig()
            self.assertNotIn('chmod', str(instance.system.call_args_list))

    def test_root_entrypoint_is_rejected_before_creating_state(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(module.os, 'geteuid', return_value=0), patch.object(module.sys, 'argv', ['rtx4090.py', '--directory', folder]), patch.object(module, 'NativeInstaller') as construct, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(module.main(), 1)
            construct.assert_not_called()
            self.assertFalse((Path(folder) / 'installation.json').exists())

    def test_public_https_uses_443_tls_gateway_and_no_public_backing_services(self):
        self.assertEqual(browser_origin('https://VIDEOQ.example.com:443/'), 'https://videoq.example.com')
        config = gateway_config('https://videoq.example.com')
        self.assertIn('disable_http_challenge', config)
        self.assertIn('https://videoq.example.com', config)
        units = forwarding_units(443, '10.43.0.20', public_https=True)
        self.assertIn('ListenStream=0.0.0.0:443', units['videoq-port-forward.socket'])
        self.assertIn('10.43.0.20:443', units['videoq-port-forward.service'])
        raw = [
            {'kind':'Service','metadata':{'name':'videoq-gateway'},'spec':{'type':'NodePort','ports':[]}},
            {'kind':'Deployment','metadata':{'name':'videoq-gateway'},'spec':{'template':{'metadata':{},'spec':{'containers':[{}]}}}},
        ]
        _, plan = backing_plan(module.EXAMPLE, 'https://videoq.example.com', 40, raw)
        self.assertEqual(plan[0]['spec']['type'], 'ClusterIP')
        self.assertEqual(plan[0]['spec']['ports'][0]['port'], 443)
        self.assertTrue(plan[1]['spec']['template']['spec']['securityContext']['runAsNonRoot'])

    def test_url_migration_is_explicit_and_preserves_old_origin_until_completion(self):
        with tempfile.TemporaryDirectory() as folder:
            initial = self.instance(folder)
            initial.record(complete=True, admin_created=True)
            initial.lock.close()
            moving = self.instance(folder, '--url', 'https://videoq.example.com', '--migrate-url')
            self.assertEqual(moving.url, 'https://videoq.example.com')
            self.assertEqual(moving.state['url'], 'http://localhost:8080')
            self.assertEqual(moving.state['pending_url'], moving.url)
            self.assertTrue(moving.state['admin_created'])

    def test_url_migration_changes_only_cors_and_preserves_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            initial = self.instance(folder)
            values={name:{'KEY':'retained'} for name in ('videoq-runtime','videoq-postgres','videoq-garage')}
            values['videoq-garage']['GARAGE_CORS_ORIGINS']=initial.url
            module.private_json(initial.directory/'credentials.json',values)
            initial.lock.close()
            moving = self.instance(folder,'--url','https://videoq.example.com','--migrate-url')
            def current(*args, **kwargs):
                name=args[2]
                return json.dumps({'data':{k:base64.b64encode(v.encode()).decode() for k,v in values[name].items()}})
            moving.kube=Mock(side_effect=current); moving.apply=Mock()
            moving.credentials()
            stored=json.loads((moving.directory/'credentials.json').read_text())
            self.assertEqual(stored['videoq-garage']['GARAGE_CORS_ORIGINS'],'https://videoq.example.com')
            self.assertTrue(all(stored[name]['KEY']=='retained' for name in stored))
            moving.lock.close()
            with self.assertRaisesRegex(ValueError,'移行が未完了'):
                self.instance(folder)

    def test_https_password_setup_stays_on_the_verified_public_origin(self):
        from unittest.mock import MagicMock
        opener = MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.status = 200; response.read.return_value = b'{"status":true}'
        url='https://videoq.example.com'
        module.activate_admin(url, url+'/api/auth/reset-password/'+'a'*24, 'good-password-123', opener)
        self.assertEqual(opener.open.call_args.args[0].full_url, url+'/api/auth/reset-password')

    def test_bootstrap_shell_syntax(self):
        script = str(Path(__file__).with_name('install-rtx4090.sh'))
        subprocess.run(['bash', '-n', script], check=True)
        import re
        for index, code in enumerate(re.findall(r"<<'PY'\n(.*?)\nPY", Path(script).read_text(), re.S)):
            compile(code, f'bootstrap-python-{index}', 'exec')
        help_result = subprocess.run(['bash', script, '--help'], text=True, capture_output=True)
        self.assertEqual(help_result.returncode, 0)
        self.assertIn('Usage:', help_result.stdout)
        self.assertEqual(help_result.stderr, '')


if __name__ == '__main__': unittest.main()
