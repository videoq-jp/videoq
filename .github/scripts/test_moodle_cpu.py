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
PROBE_SPEC = importlib.util.spec_from_file_location('moodle_probe', Path(__file__).with_name('moodle-cpu-probe.py'))
probe = importlib.util.module_from_spec(PROBE_SPEC)
PROBE_SPEC.loader.exec_module(probe)
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

    def node_report(self):
        return {'nodeVersion': 'v26.13.0', 'dnsNdots': 1, 'status': 'passed',
                'lookup': {'ok': True, 'proxyMatched': True}, 'resolve4': {'ok': True, 'proxyMatched': True},
                'tls': {'ok': True, 'lookup': True, 'connected': True, 'secure': True},
                'login': {'ok': True, 'httpStatus': 200}, 'oauth': {'ok': True, 'httpStatus': 401}}

    def test_node_base_is_read_from_the_reviewed_immutable_api_dockerfile(self):
        self.assertRegex(install.node_image(), r'^node:\d+\.\d+\.\d+-alpine@sha256:[a-f0-9]{64}$')
        path = self.root / 'Dockerfile'
        for source in ['FROM node:latest AS base', 'FROM unreviewed.invalid/node@sha256:' + 'a' * 64 + ' AS base',
                       'FROM node:26.13.0-alpine AS base']:
            path.write_text(source)
            with self.assertRaises(ValueError):
                install.node_image(path)

    def test_node_transport_recomputes_success_and_discards_private_or_invalid_metadata(self):
        value = self.node_report()
        self.assertEqual(runtime.node_transport_evidence(value), value)
        value['oauth'] = {'ok': False, 'httpStatus': True, 'kind': 'timeout', 'codes': ['EAI_AGAIN', 'PRIVATE', True],
                          'body': 'PRIVATE', 'message': 'PRIVATE'}
        evidence = runtime.node_transport_evidence(value)
        self.assertEqual(evidence['status'], 'failed')
        self.assertEqual(evidence['oauth'], {'ok': False, 'kind': 'timeout', 'codes': ['EAI_AGAIN']})
        self.assertNotIn('PRIVATE', json.dumps(evidence))
        for phase, field in [('lookup', 'proxyMatched'), ('resolve4', 'ok'), ('tls', 'secure'), ('login', 'ok')]:
            changed = self.node_report(); changed[phase][field] = 1
            self.assertEqual(runtime.node_transport_evidence(changed)['status'], 'failed')
        for value in [None, [], {}, {'nodeVersion': 'PRIVATE'}, {'nodeVersion': 'v26.13.0'}]:
            with self.assertRaises(ValueError):
                runtime.node_transport_evidence(value)

    def test_node_probe_has_no_service_account_or_credentials_and_mounts_only_public_ca(self):
        fixture = self.instance()
        with patch.object(fixture, 'assert_owner'), patch.object(fixture, 'apply') as apply, \
                patch.object(fixture, 'k', side_effect=['', '', '{"spec":{"clusterIP":"10.96.3.42"}}',
                                                       'Succeeded', json.dumps(self.node_report())]):
            self.assertEqual(fixture.verify_node_transport(), self.node_report())
        items = apply.call_args.args[0]
        pod = next(item for item in items if item['kind'] == 'Pod')
        self.assertFalse(pod['spec']['automountServiceAccountToken'])
        self.assertEqual(pod['spec']['dnsConfig'], {'options': [{'name': 'ndots', 'value': '1'}]})
        self.assertNotIn('dnsPolicy', pod['spec'])
        self.assertEqual(pod['spec']['securityContext']['runAsUser'], 1000)
        container = pod['spec']['containers'][0]
        self.assertEqual(container['image'], 'videoq-moodle-node:onprem-ci')
        self.assertEqual(container['imagePullPolicy'], 'Never')
        self.assertTrue(container['securityContext']['readOnlyRootFilesystem'])
        self.assertFalse(container['securityContext']['allowPrivilegeEscalation'])
        self.assertEqual(container['securityContext']['capabilities']['drop'], ['ALL'])
        self.assertEqual({item['name'] for item in container['env']},
                         {'NODE_EXTRA_CA_CERTS', 'VIDEOQ_MOODLE_TRANSPORT_PROBE', 'VIDEOQ_MOODLE_EXPECTED_PROXY'})
        self.assertEqual({item['configMap']['name'] for item in pod['spec']['volumes']},
                         {'moodle-cpu-ca', 'moodle-cpu-node-transport'})
        self.assertEqual((fixture.output / 'node-transport.log').stat().st_mode & 0o777, 0o600)

    def test_node_probe_refuses_preexisting_resources_before_service_or_pod_mutation(self):
        fixture = self.instance()
        with patch.object(fixture, 'assert_owner'), patch.object(fixture, 'apply') as apply, \
                patch.object(fixture, 'k', side_effect=['pod/existing', '']):
            with self.assertRaisesRegex(RuntimeError, 'Refusing to adopt'):
                fixture.verify_node_transport()
        apply.assert_not_called()

    def test_browser_failure_summary_never_reflects_private_browser_values(self):
        path = self.root / 'stage.json'
        self.assertEqual(probe.browser_failure_summary(path), 'unknown')
        for evidence in [None, [], {'stage': ['private']},
                         {'stage': 'https://private.invalid/session', 'message': 'private'},
                         {'stage': 'owner-pairing', 'failure': {'kind': ['private']}}]:
            path.write_text(json.dumps(evidence))
            expected = 'owner-pairing' if isinstance(evidence, dict) and evidence.get('stage') == 'owner-pairing' else 'unknown'
            self.assertEqual(probe.browser_failure_summary(path), expected)
        path.write_text('{')
        self.assertEqual(probe.browser_failure_summary(path), 'unknown')
        evidence = {'stage': 'real-native-question', 'failure': {
            'kind': 'assertion', 'line': 214, 'column': 7, 'message': 'private', 'stack': 'private'}}
        path.write_text(json.dumps(evidence))
        self.assertEqual(probe.browser_failure_summary(path), 'real-native-question (assertion at acceptance.mjs:214:7)')
        for row, column in [(True, 2), (2, False), (0, 2), (2, 100001), ('private', 2)]:
            evidence['failure'].update(line=row, column=column)
            path.write_text(json.dumps(evidence))
            self.assertEqual(probe.browser_failure_summary(path), 'real-native-question (assertion)')

    def test_command_failure_summary_uses_only_fixed_labels_and_bounded_values(self):
        command = {'operation': 'moodle-tick', 'exitCode': 1, 'message': 'PRIVATE', 'php': {
            'kind': 'Error', 'code': 'invalidconfiguration', 'source': 'fixture.php', 'line': 244, 'stack': 'PRIVATE'}}
        self.assertEqual(probe.command_failure_summary(command),
                         '; moodle-tick exit=1 php=Error invalidconfiguration at fixture.php:244')
        command = {'operation': 'backend-maintenance', 'exitCode': 1, 'http': {
            'service': 'moodle-oauth', 'httpStatus': 403, 'requestFailed': True, 'code': 'PRIVATE', 'body': 'PRIVATE'},
            'maintenance': [{'task': 'ltiMaterials', 'reason': 'materials-service-unavailable', 'error': 'PRIVATE'},
                            {'task': 'PRIVATE', 'reason': 'other'}]}
        self.assertEqual(probe.command_failure_summary(command),
                         '; backend-maintenance exit=1 moodle-oauth HTTP=403 request-error ltiMaterials=materials-service-unavailable')
        path = self.root / 'stage.json'
        path.write_text(json.dumps({'stage': 'real-moodle-processing', 'failure': {'kind': 'error', 'command': command}}))
        self.assertNotIn('PRIVATE', probe.browser_failure_summary(path))

    def test_command_failure_summary_rejects_private_strings_and_invalid_types(self):
        for value in [None, [], {'operation': 'PRIVATE'}, {'operation': ['PRIVATE']}]:
            self.assertEqual(probe.command_failure_summary(value), '')
        command = {'operation': 'moodle-tick', 'exitCode': True, 'signal': ['PRIVATE'], 'timedOut': 'PRIVATE',
                   'php': {'kind': ['PRIVATE'], 'code': ['PRIVATE'], 'source': ['PRIVATE'], 'line': True}}
        self.assertEqual(probe.command_failure_summary(command), '; moodle-tick')
        for value in [None, [], {'service': 'PRIVATE'}, {'service': ['PRIVATE']},
                      {'service': 'moodle-oauth', 'httpStatus': True, 'requestFailed': 'PRIVATE', 'code': ['PRIVATE']}]:
            command = {'operation': 'backend-maintenance', 'http': value,
                       'maintenance': [None, [], {'task': 'PRIVATE', 'reason': 'PRIVATE'},
                                       {'task': 'health', 'reason': ['PRIVATE']}]}
            actual = probe.command_failure_summary(command)
            self.assertNotIn('PRIVATE', actual)
            self.assertNotIn('True', actual)
            self.assertNotIn('request-error', actual)
            self.assertNotIn('health=', actual)

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

    def test_actual_cpu_configuration_preserves_model_endpoints_and_mounts_only_public_ca(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        directory = self.root / 'private'
        directory.mkdir()
        values = {'publicUrl': 'http://127.0.0.1:18787',
                  'storage': {'endpoint': 'http://127.0.0.1:19000', 'internalEndpoint': 'http://garage:3900'},
                  'ai': {'openaiBaseUrl': 'http://videoq-inference-chat:8000/v1', 'llmModel': 'videoq-chat',
                         'embeddingBaseUrl': 'http://videoq-inference-embedding:8000/v1'},
                  'api': {'extraEnv': [{'name': 'EXISTING_SETTING', 'value': 'preserved'}]}}
        (self.root / 'values.json').write_text(json.dumps(values))
        fixture = SimpleNamespace(output=directory, kubeconfig=self.kubeconfig, assert_owner=Mock(), k=Mock())
        with patch.object(probe.subprocess, 'run') as run:
            self.assertEqual(probe.configure_api(fixture, self.root, Path('charts/videoq')), 'scene_embeddings')
        fixture.assert_owner.assert_called_once()
        actual = json.loads((directory / 'values.json').read_text())
        self.assertEqual(actual['ai'], values['ai'])
        self.assertEqual(actual['storage']['internalEndpoint'], values['storage']['internalEndpoint'])
        self.assertIn({'name': 'EXISTING_SETTING', 'value': 'preserved'}, actual['api']['extraEnv'])
        self.assertNotIn('NODE_TLS_REJECT_UNAUTHORIZED', json.dumps(actual))
        patch_data = probe.api_ca_patch()['spec']['template']['spec']
        self.assertEqual(patch_data['dnsConfig'], {'options': [{'name': 'ndots', 'value': '1'}]})
        self.assertNotIn('dnsPolicy', patch_data)
        self.assertEqual(patch_data['volumes'], [{'name': 'moodle-cpu-ca', 'configMap': {'name': 'moodle-cpu-ca'}}])
        self.assertTrue(patch_data['containers'][0]['volumeMounts'][0]['readOnly'])
        self.assertEqual(run.call_args.args[0][:3], ['helm', 'upgrade', 'videoq'])

    def test_moodle_refuses_a_mock_or_public_provider_before_helm_or_cluster_changes(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        (self.root / 'values.json').write_text(json.dumps({'publicUrl': 'http://127.0.0.1:18787',
            'storage': {}, 'ai': {'openaiBaseUrl': 'https://external.invalid/v1'}, 'api': {}}))
        fixture = SimpleNamespace(assert_owner=Mock(), k=Mock())
        with patch.object(probe.subprocess, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'actual parent CPU'):
                probe.configure_api(fixture, self.root, Path('charts/videoq'))
        run.assert_not_called()
        fixture.k.assert_not_called()


if __name__ == '__main__':
    unittest.main()
