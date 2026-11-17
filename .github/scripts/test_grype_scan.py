import base64
import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('grype_scan', pathlib.Path(__file__).with_name('grype-scan.py'))
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


def fixture():
    artifact = {'id': 'package', 'name': 'example', 'version': '1.0', 'type': 'deb',
                'purl': 'pkg:deb/ubuntu/example@1.0?arch=arm64&distro=ubuntu-22.04', 'foundBy': 'dpkg-db-cataloger'}
    metadata = {'repoDigests': ['index.docker.io/example/server@sha256:' + 'a' * 64],
                'config': base64.b64encode(json.dumps({'architecture': 'arm64', 'os': 'linux',
                    'config': {'Entrypoint': ['/server']}}).encode()).decode()}
    source = {'type': 'image', 'metadata': metadata, 'name': 'server'}
    sbom = {'artifacts': [artifact], 'source': source, 'distro': {'id': 'ubuntu', 'versionID': '22.04'}}
    raw = {'source': {'type': 'image', 'target': copy.deepcopy(metadata)}, 'matches': [
        {'artifact': copy.deepcopy(artifact), 'vulnerability': {'id': 'CVE-2026-1', 'severity': 'High', 'fix': {'versions': []}}}]}
    return sbom, raw


class GrypeScan(unittest.TestCase):
    def test_inventory_identity_and_unfixed_findings_are_preserved(self):
        sbom, raw = fixture()
        before = copy.deepcopy((sbom, raw))
        report = scan.normalize(sbom, raw)
        self.assertEqual(report['Metadata']['ImageConfig']['architecture'], 'arm64')
        self.assertIn('example/server@sha256:' + 'a' * 64, report['Metadata']['RepoDigests'])
        self.assertEqual(report['Results'][0]['Vulnerabilities'][0]['FixedVersion'], '')
        self.assertEqual(report['Results'][0]['Packages'][0]['Identifier']['PURL'], sbom['artifacts'][0]['purl'])
        self.assertEqual((sbom, raw), before)

    def test_refuses_filtered_mismatched_or_unknown_reports(self):
        for change in [lambda r: r.update(ignoredMatches=[{}]),
                       lambda r: r['source']['target'].update(repoDigests=[]),
                       lambda r: r['matches'][0]['artifact'].update(version='2'),
                       lambda r: r['matches'][0]['vulnerability'].update(severity='invalid'),
                       lambda r: r.pop('matches')]:
            sbom, raw = fixture()
            change(raw)
            with self.assertRaises(ValueError):
                scan.normalize(sbom, raw)

    def test_unknown_remains_visible_and_does_not_invent_vendor_provenance(self):
        sbom, raw = fixture()
        raw['matches'][0]['vulnerability']['severity'] = 'Unknown'
        result = scan.normalize(sbom, raw)['Results'][0]
        self.assertEqual(result['Vulnerabilities'][0]['Severity'], 'UNKNOWN')
        self.assertNotEqual(result['Packages'][0]['AnalyzedBy'], 'sbom')

    def test_vex_only_accepts_exact_cve_and_versioned_package_identity(self):
        for status in ['fixed', 'not_affected']:
            sbom, raw = fixture()
            with tempfile.TemporaryDirectory() as directory:
                path = pathlib.Path(directory) / 'vex.json'
                path.write_text(json.dumps({'statements': [{'vulnerability': {'name': 'CVE-2026-1'},
                    'products': [{'@id': sbom['artifacts'][0]['purl']}], 'status': status,
                    'justification': 'vulnerable_code_not_present'}]}))
                result = scan.normalize(sbom, raw, [str(path)])['Results'][0]
                self.assertFalse(result['Vulnerabilities'])
                self.assertEqual(len(result['ExperimentalModifiedFindings']), 1)
                raw['matches'][0]['vulnerability']['id'] = 'CVE-2026-2'
                self.assertEqual(len(scan.normalize(sbom, raw, [str(path)])['Results'][0]['Vulnerabilities']), 1)

    def test_strict_blocks_unfixed_and_keeps_all_evidence_while_assess_defers(self):
        sbom, raw = fixture()
        for gate in ['strict', 'assess']:
            with tempfile.TemporaryDirectory() as directory:
                output = pathlib.Path(directory) / 'security.json'
                commands = []

                def run(command, **kwargs):
                    commands.append(command)
                    if command[0] == 'syft':
                        pathlib.Path(str(output) + '.syft.json').write_text(json.dumps(sbom))
                    else:
                        pathlib.Path(str(output) + '.grype.json').write_text(json.dumps(raw))

                with patch.object(scan.subprocess, 'run', side_effect=run), patch('sys.argv', [
                    'scan', '--source', 'registry:example/server', '--output', str(output), '--gate', gate]):
                    if gate == 'strict':
                        with self.assertRaises(SystemExit):
                            scan.main()
                    else:
                        scan.main()
                self.assertTrue(output.exists())
                self.assertEqual(json.loads(pathlib.Path(str(output) + '.grype.json').read_text()), raw)
                self.assertEqual(len(commands), 2)
                self.assertIn('sbom:' + str(output) + '.syft.json', commands[1])

    def test_upstream_hint_preserves_binary_identity_but_version_and_arch_still_differ(self):
        original = 'pkg:deb/ubuntu/libapt-pkg6.0t64@2.8.3?arch=amd64&distro=ubuntu-24.04'
        self.assertEqual(scan.policy_purl(original + '&upstream=apt'), original)
        self.assertNotEqual(scan.policy_purl(original.replace('amd64', 'arm64')), original)
        self.assertNotEqual(scan.policy_purl(original.replace('@2.8.3', '@2.8.4')), original)

    def test_scanner_failure_cannot_produce_success(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(scan.subprocess, 'run', side_effect=RuntimeError('scan failed')):
            with patch('sys.argv', ['scan', '--source', 'dir:/example', '--output', directory + '/report.json']):
                with self.assertRaises(RuntimeError):
                    scan.main()
