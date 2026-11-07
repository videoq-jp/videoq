import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('moodle_runtime', Path(__file__).with_name('moodle-cpu-runtime.py'))
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
INSTALL_SPEC = importlib.util.spec_from_file_location('moodle_install', Path(__file__).with_name('moodle-install-acceptance.py'))
install = importlib.util.module_from_spec(INSTALL_SPEC)
INSTALL_SPEC.loader.exec_module(install)
OWNER = 'a' * 32
COREFILE = '.:53 {\n    errors\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n        pods insecure\n    }\n}\n'


class MoodleCpuSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.kubeconfig = self.root / 'kubeconfig'
        self.kubeconfig.touch(mode=0o600)

    def instance(self):
        return runtime.MoodleRuntime(self.kubeconfig, self.root / 'private', OWNER)

    def test_all_public_sources_and_base_images_are_immutable(self):
        pins = runtime.sources.read_pins()
        for component in runtime.sources.REPOSITORIES:
            self.assertRegex(pins[component]['revision'], r'^[a-f0-9]{40}$')
        for field in ['phpImage', 'proxyImage']:
            self.assertRegex(pins[field], r'@sha256:[a-f0-9]{64}$')
        for field, value in [('revision', 'main'), ('repository', 'https://unreviewed.invalid/repo.git')]:
            changed = copy.deepcopy(pins)
            changed['moodle'][field] = value
            path = self.root / 'pins.json'
            path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError):
                runtime.sources.read_pins(path)

    def test_existing_or_checkout_state_directories_are_never_adopted(self):
        existing = self.root / 'existing'
        existing.mkdir()
        (existing / 'private-state').write_text('keep')
        link = self.root / 'link'
        link.symlink_to(existing, target_is_directory=True)
        for path in [existing, link, Path('.'), runtime.ROOT / 'untracked-fixture']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                runtime.private_directory(path)
        self.assertEqual((existing / 'private-state').read_text(), 'keep')
        self.assertEqual(runtime.private_directory(self.root / 'new').stat().st_mode & 0o777, 0o700)

    def test_no_mutation_when_parent_ownership_is_missing_or_mismatched(self):
        for marker in [{}, {'data': {'owner': 'b' * 32}, 'metadata': {'labels': {runtime.OWNER_LABEL: OWNER}}}]:
            fixture = self.instance() if not (self.root / 'private').exists() else runtime.MoodleRuntime(
                self.kubeconfig, self.root / 'another', OWNER)
            with patch.object(fixture, 'k', side_effect=['kind-videoq-onprem-lab', json.dumps(marker)]) as k:
                with self.assertRaises((ValueError, KeyError)):
                    fixture.provision(self.root / 'absent-video')
            self.assertEqual(len(k.call_args_list), 2)
            self.assertTrue(all(call.args[0] in ['config', 'get'] for call in k.call_args_list))

    def test_current_or_unrelated_cluster_context_is_rejected_before_other_reads(self):
        fixture = self.instance()
        with patch.object(fixture, 'k', return_value='production') as k:
            with self.assertRaisesRegex(ValueError, 'explicit disposable'):
                fixture.fixture('seed')
        k.assert_called_once_with('config', 'current-context')

    def test_existing_moodle_resources_are_not_overwritten(self):
        for name in ['moodle', 'db', 'moodle-proxy', 'moodle-cpu-ca']:
            fixture = self.instance() if not (self.root / 'private').exists() else runtime.MoodleRuntime(
                self.kubeconfig, self.root / name, OWNER)
            with patch.object(fixture, 'assert_owner'), patch.object(fixture, 'k', return_value=name) as k:
                with self.assertRaisesRegex(RuntimeError, 'refusing to adopt'):
                    fixture.provision(self.root / 'absent-video')
            self.assertEqual(len(k.call_args_list), 1)
            self.assertEqual(k.call_args.args[0], 'get')

    def test_local_dns_keeps_kubernetes_resolution_and_never_enables_public_forwarding(self):
        modified = runtime.dns_with_proxy(COREFILE, '10.96.3.42')
        self.assertIn('kubernetes cluster.local', modified)
        self.assertIn('10.96.3.42 moodle.localhost videoq.localhost storage.videoq.localhost', modified)
        self.assertIn('fallthrough', modified)
        for source, ip in [(COREFILE, '8.8.8.8'), (COREFILE, '127.0.0.1'),
                           (COREFILE, '::1'), ('different', '10.96.3.42'),
                           (COREFILE.replace('errors', 'forward . /etc/resolv.conf'), '10.96.3.42'),
                           (modified, '10.96.3.42')]:
            with self.subTest(ip=ip), self.assertRaises(ValueError):
                runtime.dns_with_proxy(source, ip)

    def test_fixture_secrets_are_secret_references_and_no_service_is_exposed(self):
        secret = 'b' * 64
        resources = runtime.moodle_resources(OWNER, secret, b'public fixture' * 10) + runtime.proxy_resources(OWNER)
        for item in resources:
            if item['kind'] == 'PersistentVolume':
                self.assertNotIn('namespace', item['metadata'])
                self.assertTrue(item['spec']['hostPath']['path'].startswith('/videoq-moodle-cpu/' + OWNER + '/'))
                self.assertEqual(item['spec']['storageClassName'], '')
            else:
                self.assertEqual(item['metadata']['namespace'], 'videoq-validation')
            self.assertEqual(item['metadata']['labels'][runtime.OWNER_LABEL], OWNER)
            if item['kind'] == 'Service':
                self.assertNotIn(item['spec'].get('type'), ['NodePort', 'LoadBalancer'])
                self.assertNotIn('externalIPs', item['spec'])
            if item['kind'] == 'Deployment':
                pod = item['spec']['template']['spec']
                self.assertFalse(pod['automountServiceAccountToken'])
                self.assertNotIn('hostNetwork', pod)
                self.assertNotIn('hostPID', pod)
                self.assertFalse(any('hostPath' in volume for volume in pod['volumes']))
                for container in pod['containers']:
                    self.assertEqual(container['imagePullPolicy'], 'Never')
                    self.assertNotIn(secret, json.dumps(container))
                    self.assertNotIn('privileged', container.get('securityContext', {}))
        serialized = json.dumps([item for item in resources if item['kind'] != 'Secret'])
        self.assertNotIn(secret, serialized)
        for args in [('bad', secret, b'x' * 100), (OWNER, 'weak', b'x' * 100),
                     (OWNER, secret, b''), (OWNER, secret, b'x' * 900_001)]:
            with self.subTest(args=args[:2]), self.assertRaises(ValueError):
                runtime.moodle_resources(*args)

    def test_developer_diagnostics_cannot_be_accepted_as_a_successful_json_result(self):
        fixture = self.instance()
        with patch.object(fixture, 'assert_owner'), patch.object(fixture, 'k', return_value='Deprecated: something\n{}'):
            with self.assertRaisesRegex(RuntimeError, 'diagnostics'):
                fixture.fixture('status')

    def test_role_verification_requires_current_denial_and_restoration(self):
        role = {'siteAdmin': False, 'activeEnrolment': True, 'manageContent': False,
                'manageActivities': False, 'viewReports': False, 'sourceVisible': True}
        teacher = {**role, 'manageContent': True, 'manageActivities': True, 'viewReports': True}
        result = {'authority': {'teacher': teacher, 'learner': role,
                  'outsider': {**role, 'activeEnrolment': False}},
                  'status': 'off', 'enabled': False, 'connectionConfigured': False}
        self.assertGreater(runtime.verify_roles('status', result), 10)
        for actor, field, value in [('teacher', 'siteAdmin', True), ('learner', 'manageContent', True),
                                    ('learner', 'viewReports', True), ('outsider', 'activeEnrolment', True),
                                    ('teacher', 'activeEnrolment', False)]:
            invalid = copy.deepcopy(result)
            invalid['authority'][actor][field] = value
            with self.subTest(actor=actor, field=field), self.assertRaises(RuntimeError):
                runtime.verify_roles('status', invalid)
        for action, actor, field in [('hide', 'learner', 'sourceVisible'),
                                    ('suspend', 'learner', 'activeEnrolment'),
                                    ('deny-reports', 'teacher', 'viewReports')]:
            with self.subTest(action=action), self.assertRaises(RuntimeError):
                runtime.verify_roles(action, result)
            changed = copy.deepcopy(result)
            changed['authority'][actor][field] = False
            runtime.verify_roles(action, changed)

    def test_existing_cluster_and_low_capacity_stop_before_pulls_or_mutations(self):
        for reads, message in [(['videoq-onprem-lab'], 'already exists'),
                               (['', str(2 * 1024**3)], '4 GiB')]:
            directory = self.root / ('run-' + str(len(reads)))
            with patch.object(install.subprocess, 'check_output', side_effect=reads) as read, \
                    patch.object(install.subprocess, 'run') as mutate:
                with self.assertRaisesRegex(RuntimeError, message):
                    install.run(directory, 'videoq-moodle:test')
            mutate.assert_not_called()
            self.assertEqual(len(read.call_args_list), len(reads))

    def test_unpinned_moodle_image_is_rejected_without_registry_or_cluster_writes(self):
        pins = runtime.sources.read_pins()
        for image in ['docker.io/unknown/moodle:latest', 'videoq-moodle@sha256:' + 'a' * 64]:
            with self.subTest(image=image), patch.object(install.subprocess, 'check_output') as read:
                with self.assertRaises(ValueError):
                    install.check_image(image, pins)
            read.assert_not_called()
        with patch.object(install.subprocess, 'check_output', return_value='[{"Config":{"Labels":{}},"Id":"wrong"}]'):
            with self.assertRaisesRegex(ValueError, 'source labels'):
                install.check_image('videoq-moodle:test', pins)

    def test_network_failure_evidence_never_publishes_raw_errors_or_reflected_values(self):
        expected = {'stage': 'private-https', 'curlErrno': 7, 'httpStatus': 0, 'tlsVerifyResult': 0}
        self.assertEqual(runtime.network_failure('raw private content\nVIDEOQ_CPU_NETWORK ' + json.dumps(expected)), expected)
        for invalid in [{**expected, 'password': 'private'}, {**expected, 'curlErrno': 'private'},
                        {'stage': 'private-token'}, {**expected, 'tlsVerifyResult': True}]:
            self.assertIsNone(runtime.network_failure('VIDEOQ_CPU_NETWORK ' + json.dumps(invalid)))
        self.assertIsNone(runtime.network_failure('raw private failure without approved metadata'))


if __name__ == '__main__':
    unittest.main()
