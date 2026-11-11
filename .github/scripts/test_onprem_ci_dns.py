import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('ci_dns', Path(__file__).with_name('configure-onprem-ci-dns.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CiDnsTests(unittest.TestCase):
    def setUp(self):
        self.commands = []
        self.env = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}

    def execute(self, command, **kwargs):
        self.commands.append(command)
        output = '[{"dev":"eth0","metric":100}]' if command[0] == 'ip' else ''
        return subprocess.CompletedProcess(command, 0, output, '')

    def test_cannot_change_dns_on_the_user_server_or_a_self_hosted_runner(self):
        for env in ({}, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'self-hosted'}):
            with self.assertRaises(ValueError):
                module.configure(environment=env, execute=self.execute)
        self.assertEqual(self.commands, [])

    def test_host_only_setup_retains_existing_service_containers(self):
        module.configure(environment=self.env, execute=self.execute, resolve=lambda *a, **k: [('answer',)])
        self.assertTrue(any(command[:4] == ['sudo','-n','resolvectl','dns'] for command in self.commands))
        self.assertFalse(any('docker' in command or 'restart' in command for command in self.commands))

    def test_docker_restart_refuses_live_service_containers_before_any_mutation(self):
        def active(command, **kwargs):
            self.commands.append(command)
            return subprocess.CompletedProcess(command, 0, 'active-container\n', '')
        with self.assertRaisesRegex(ValueError, 'active service'):
            module.configure(docker=True, environment=self.env, execute=active)
        self.assertEqual(self.commands, [['docker','ps','-q']])

    def test_dns_failure_prevents_docker_changes_and_build_continuation(self):
        with self.assertRaises(ValueError):
            module.configure(docker=True, environment=self.env, execute=self.execute, resolve=lambda *a, **k: [])
        self.assertFalse(any('restart' in command for command in self.commands))

    def test_daemon_update_preserves_unrelated_settings_and_file_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'daemon.json'
            original = {'log-driver':'local', 'features':{'containerd-snapshotter':True}, 'dns':['8.8.4.4']}
            path.write_text(json.dumps(original))
            path.chmod(0o600)
            code = module.DOCKER_CONFIG.replace("Path('/etc/docker/daemon.json')", 'Path('+repr(str(path))+')')
            result = subprocess.run([sys.executable,'-c',code],text=True,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)
            updated = json.loads(path.read_text())
            self.assertEqual(updated['log-driver'],original['log-driver'])
            self.assertEqual(updated['features'],original['features'])
            self.assertEqual(updated['dns'],list(module.RESOLVERS))
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            self.assertEqual(list(Path(folder).iterdir()),[path])
            path.write_text('{broken')
            result = subprocess.run([sys.executable,'-c',code],text=True,capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(path.read_text(),'{broken')

    def test_oci_requires_explicit_docker_restart_and_checks_actual_backend(self):
        with self.assertRaisesRegex(ValueError, 'requires --docker'):
            module.configure(oci=True, environment=self.env, execute=self.execute)
        self.assertEqual(self.commands, [])
        with self.assertRaisesRegex(ValueError, 'not activated'):
            module.configure(docker=True, oci=True, environment=self.env,
                             execute=self.execute, resolve=lambda *a, **k: [('answer',)])
        self.assertTrue(any('--oci' in c for c in self.commands))
        self.commands.clear()
        def containerd(command, **kwargs):
            result = self.execute(command, **kwargs)
            if command[:3] == ['docker', 'info', '--format']:
                result.stdout = '[["driver-type","io.containerd.snapshotter.v1"]]'
            return result
        module.configure(docker=True, oci=True, environment=self.env,
                         execute=containerd, resolve=lambda *a, **k: [('answer',)])

    def test_oci_settings_preserve_other_daemon_features(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'daemon.json'
            path.write_text(json.dumps({'features': {'buildkit': True}, 'log-driver': 'local'}))
            code = module.DOCKER_CONFIG.replace("Path('/etc/docker/daemon.json')", 'Path('+repr(str(path))+')')
            result = subprocess.run([sys.executable, '-c', code, '--oci'], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            config = json.loads(path.read_text())
            self.assertEqual(config['features'], {'buildkit': True, 'containerd-snapshotter': True})
            self.assertEqual(config['log-driver'], 'local')
            self.assertEqual(config['dns'], list(module.RESOLVERS))


if __name__ == '__main__':
    unittest.main()
