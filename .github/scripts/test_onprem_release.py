import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('release', Path(__file__).with_name('onprem-release.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
SOURCE = 'a' * 40


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.charts = {key: self.root / (name + '-0.1.0-sha.' + SOURCE + '.tgz') for key, name in release.CHARTS.items()}
        for chart in self.charts.values(): chart.write_bytes(b'reviewed chart fixture')
        self.data = {'schemaVersion': 5, 'repository': release.REPOSITORY, 'sourceSha': SOURCE,
                     'images': {c: {'repository': release.PREFIX + c, 'platforms': release.PLATFORMS[c], 'digest': 'sha256:' + 'b' * 64} for c in release.COMPONENTS},
                     'charts': {key: {'name': chart.name, 'digest': 'sha256:' + release.hashlib.sha256(chart.read_bytes()).hexdigest()} for key, chart in self.charts.items()}}
        self.manifest = self.root / 'release.json'
        self.manifest.write_text(json.dumps(self.data))

    def test_verification_pins_oidc_workflow_source_ref_and_commit(self):
        with patch.object(release.subprocess, 'run') as run:
            values, inference = release.verify(self.manifest, SOURCE)
        self.assertTrue(values['requireImageDigests'])
        self.assertTrue(inference['requireImageDigests'])
        self.assertEqual(inference['whisper']['image']['repository'], release.PREFIX + 'transcription-gateway')
        self.assertNotIn('vllmImage', inference['whisper'])
        self.assertNotIn('vllm', inference)
        self.assertEqual(run.call_count, 7)
        for call in run.call_args_list:
            command = call.args[0]
            self.assertIn('--deny-self-hosted-runners', command)
            for flag, expected in [('--repo', release.REPOSITORY), ('--signer-workflow', release.WORKFLOW),
                                   ('--source-digest', SOURCE), ('--source-ref', 'refs/heads/main')]:
                self.assertEqual(command[command.index(flag) + 1], expected)
            self.assertTrue(call.kwargs['check'])
        self.assertIn('@sha256:', run.call_args_list[-1].args[0][3])

    def test_assembly_emits_new_names_and_round_trips_to_helm_values(self):
        for c in release.COMPONENTS:
            (self.root / (c + '.digest')).write_text('sha256:' + 'b' * 64)
        with patch('sys.argv', ['script', 'assemble', SOURCE, str(self.root)]): release.main()
        data = json.loads(self.manifest.read_text())
        self.assertEqual(data['schemaVersion'], 5)
        self.assertEqual(set(data['images']), {'api', 'worker', 'web', 'transcription-gateway'})
        with patch.object(release.subprocess, 'run'):
            values, inference = release.verify(self.manifest, SOURCE)
        self.assertEqual(inference['whisper']['image']['repository'], release.PREFIX+'transcription-gateway')
        self.assertNotIn('vllm', inference)

    def test_historical_owner_requires_historical_images_and_signer_for_every_subject(self):
        historical = release.HISTORICAL_REPOSITORY
        self.data['schemaVersion'] = 4
        self.data['images']['vllm-engine'] = {'platforms': ['linux/amd64'], 'digest': 'sha256:' + 'd' * 64}
        self.data['repository'] = historical
        for component, image in self.data['images'].items():
            image['repository'] = release.repository(component, version=4, source_repository=historical)
        self.manifest.write_text(json.dumps(self.data))
        def download_bundle(command, **kwargs):
            if command[2] == 'download':
                (Path(kwargs['cwd']) / 'sha256-fixture.jsonl').write_text('{}\n')
        with patch.object(release.subprocess, 'run', side_effect=download_bundle) as run:
            values, _ = release.verify(self.manifest, SOURCE)
        self.assertEqual(run.call_count, 16)
        self.assertEqual(values['api']['image']['repository'], 'ghcr.io/' + historical + '-api')
        for call in run.call_args_list:
            command = call.args[0]
            if command[2] == 'download':
                self.assertEqual(command[-2:], ['--owner', 'yukiharada1228'])
                continue
            self.assertIn('--bundle', command)
            self.assertEqual(command[command.index('--repo') + 1], historical)
            self.assertEqual(command[command.index('--signer-workflow') + 1], historical + '/.github/workflows/onprem-release.yml')
        self.data['images']['api']['repository'] = release.repository('api')
        with self.assertRaisesRegex(ValueError, 'Unexpected image repository'):
            release.validate(self.data, SOURCE)

    def test_arbitrary_historical_signer_is_rejected_before_invoking_gh(self):
        with patch.object(release.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                release.attest(self.manifest, SOURCE, source_repository='attacker/videoq')
        run.assert_not_called()

    def test_historical_bundle_fetch_failure_cannot_bypass_verification(self):
        with patch.object(release.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'gh')) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                release.attest(self.manifest, SOURCE, source_repository=release.HISTORICAL_REPOSITORY)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][2], 'download')

    def test_legacy_schema_two_still_verifies_all_original_signed_subjects(self):
        legacy = copy.deepcopy(self.data)
        legacy['schemaVersion'] = 2
        components, prefix, platforms = release.layout(2)
        legacy['images'] = {c: {'repository': release.repository(c, legacy['schemaVersion']), 'platforms': platforms[c], 'digest': 'sha256:' + 'c' * 64} for c in components}
        self.manifest.write_text(json.dumps(legacy))
        with patch.object(release.subprocess, 'run') as run:
            values, inference = release.verify(self.manifest, SOURCE)
        self.assertEqual(run.call_count, 8)
        self.assertEqual(values['api']['image']['repository'], release.LEGACY_PREFIX + 'api')
        self.assertEqual(inference['whisper']['image']['repository'], release.LEGACY_PREFIX + 'whisper')
        self.assertEqual(inference['vllm']['image']['repository'], release.LEGACY_PREFIX + 'whisper-vllm')

    def test_schema_three_retains_renamed_signed_gpu_engine(self):
        legacy = copy.deepcopy(self.data)
        legacy['schemaVersion'] = 3
        components, prefix, platforms = release.layout(3)
        legacy['images'] = {c: {'repository': release.repository(c, legacy['schemaVersion']), 'platforms': platforms[c], 'digest': 'sha256:' + 'c' * 64} for c in components}
        self.manifest.write_text(json.dumps(legacy))
        with patch.object(release.subprocess, 'run') as run:
            values, inference = release.verify(self.manifest, SOURCE)
        self.assertEqual(run.call_count, 8)
        self.assertEqual(inference['vllm']['image']['repository'], release.LEGACY_PREFIX+'whisper-vllm')

    def test_released_schema_four_preserves_new_gpu_namespace_and_all_eight_subjects(self):
        data = copy.deepcopy(self.data)
        data['schemaVersion'] = 4
        data['images']['vllm-engine'] = {'repository': release.PREFIX+'vllm', 'platforms': ['linux/amd64'], 'digest': 'sha256:'+'d'*64}
        self.manifest.write_text(json.dumps(data))
        with patch.object(release.subprocess, 'run') as run:
            _, inference = release.verify(self.manifest, SOURCE)
        self.assertEqual(run.call_count, 8)
        self.assertEqual(inference['whisper']['vllmImage']['repository'], release.PREFIX+'vllm')
        self.assertEqual(inference['whisper']['vllmImage'], inference['vllm']['image'])
        for wrong in (release.LEGACY_PREFIX+'whisper-vllm', release.PREFIX+'vllm-engine'):
            data['images']['vllm-engine']['repository'] = wrong
            with self.assertRaises(ValueError): release.validate(data, SOURCE)
        data['schemaVersion'] = 5
        with self.assertRaises(ValueError): release.validate(data, SOURCE)

    def test_historical_layouts_never_skip_a_signature(self):
        for version in (2, 3, 4):
            data = copy.deepcopy(self.data); data['schemaVersion'] = version
            components, _, platforms = release.layout(version)
            data['images'] = {c: {'repository': release.repository(c, version), 'platforms': platforms[c], 'digest': 'sha256:'+'d'*64} for c in components}
            self.manifest.write_text(json.dumps(data))
            for failure in range(8):
                with self.subTest(version=version, failure=failure), patch.object(release.subprocess, 'run', side_effect=[None]*failure+[subprocess.CalledProcessError(1, 'gh')]):
                    with self.assertRaises(subprocess.CalledProcessError): release.verify(self.manifest, SOURCE)

    def test_layout_cannot_mix_namespaces_or_component_generations(self):
        for mutate in [lambda d: d.update(schemaVersion=2), lambda d: d.update(schemaVersion=4), lambda d: d['images']['api'].update(repository=release.LEGACY_PREFIX+'api')]:
            bad = copy.deepcopy(self.data); mutate(bad)
            with self.assertRaises(ValueError): release.validate(bad, SOURCE)
        for version in [True, None, '5', 0, 6]:
            with self.subTest(version=version), self.assertRaises(ValueError): release.layout(version)

    def test_missing_or_invalid_signature_aborts(self):
        for failure in range(7):
            with self.subTest(failure=failure), patch.object(release.subprocess, 'run', side_effect=[None] * failure + [subprocess.CalledProcessError(1, 'gh')]):
                with self.assertRaises(subprocess.CalledProcessError):
                    release.verify(self.manifest, SOURCE)

    def test_changed_chart_bytes_abort(self):
        for chart in self.charts.values():
            with self.subTest(chart=chart):
                chart.write_bytes(b'tampered')
                with patch.object(release.subprocess, 'run'), self.assertRaisesRegex(ValueError, 'Chart bytes'):
                    release.verify(self.manifest, SOURCE)
                chart.write_bytes(b'reviewed chart fixture')

    def test_wrong_repository_commit_architecture_component_or_path_abort(self):
        candidates = []
        for field, value in [('repository', 'attacker/videoq'), ('sourceSha', 'c' * 40), ('schemaVersion', 1)]:
            bad = copy.deepcopy(self.data); bad[field] = value; candidates.append(bad)
        for field, value in [('repository', 'ghcr.io/attacker/api'), ('digest', 'latest'), ('digest', 'sha256:' + '0' * 64)]:
            bad = copy.deepcopy(self.data); bad['images']['api'][field] = value; candidates.append(bad)
        for component in ['api', 'transcription-gateway']:
            bad = copy.deepcopy(self.data); bad['images'][component]['platforms'] = ['linux/arm64']; candidates.append(bad)
        bad = copy.deepcopy(self.data); bad['charts']['inference']['name'] = '../chart.tgz'; candidates.append(bad)
        bad = copy.deepcopy(self.data); del bad['images']['worker']; candidates.append(bad)
        bad = copy.deepcopy(self.data); del bad['images']['transcription-gateway']; candidates.append(bad)
        bad = copy.deepcopy(self.data); del bad['charts']['inference']; candidates.append(bad)
        for bad in candidates:
            with self.subTest(data=bad), self.assertRaises(ValueError):
                release.validate(bad, SOURCE)

    def test_failure_does_not_replace_existing_values(self):
        output = self.root / 'values.json'
        output.write_text('existing reviewed values')
        inference = self.root / 'inference.json'
        inference.write_text('existing inference values')
        with patch.object(release, 'verify', side_effect=ValueError('bad signature')), patch('sys.argv', ['script', 'verify', SOURCE, str(self.manifest), str(output), str(inference)]):
            with self.assertRaises(ValueError): release.main()
        self.assertEqual(output.read_text(), 'existing reviewed values')
        self.assertEqual(inference.read_text(), 'existing inference values')

    def test_cannot_overwrite_signed_artifacts_or_share_output_paths(self):
        output = self.root / 'values.json'
        for first, second in [(self.manifest, output), (output, self.charts['inference']), (output, output)]:
            with patch('sys.argv', ['script', 'verify', SOURCE, str(self.manifest), str(first), str(second)]), patch.object(release, 'verify') as verify:
                with self.assertRaises(ValueError): release.main()
                verify.assert_not_called()


if __name__ == '__main__':
    unittest.main()
