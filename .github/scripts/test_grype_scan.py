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

    def test_local_openssl_backports_require_pinned_patch_bytes_and_exact_package_revision(self):
        import hashlib
        root = pathlib.Path(__file__).resolve().parents[2]
        directory = root / 'apps/security/openssl'
        manifest = json.loads((directory / 'upstream-fixes.json').read_text())
        recipe = (directory / 'APKBUILD').read_text()
        self.assertEqual(len(manifest), 5)
        for name, provenance in manifest.items():
            data = (directory / name).read_bytes()
            self.assertEqual(hashlib.sha512(data).hexdigest(), provenance['sha512'])
            self.assertTrue(data.startswith(('From ' + provenance['commit'] + ' ').encode()))
            self.assertIn(provenance['sha512'] + '  ' + name, recipe)
        self.assertIn('pkgrel=100\n', recipe)
        vex = directory / 'backports.openvex.json'
        for version, cve, assessed in [
            ('3.5.9-r100', 'CVE-2026-124709', True),
            ('3.5.9-r100', 'CVE-2026-107493', True),
            ('3.5.9-r1', 'CVE-2026-124709', False),
            ('3.5.9-r100', 'CVE-2026-other', False),
        ]:
            sbom, raw = fixture()
            artifact = sbom['artifacts'][0]
            artifact.update(name='libssl3', version=version, type='apk',
                purl=f'pkg:apk/alpine/libssl3@{version}?arch=x86_64&distro=alpine-3.24.4')
            raw['matches'][0]['artifact'] = copy.deepcopy(artifact)
            raw['matches'][0]['vulnerability']['id'] = cve
            result = scan.normalize(sbom, raw, [str(vex)])['Results'][0]
            self.assertEqual(not result['Vulnerabilities'], assessed)
        for component in ['api', 'web']:
            docker = (root / f'apps/{component}/Dockerfile').read_text()
            self.assertIn('MAKEFLAGS=-j4 abuild -F -d -r', docker)
            self.assertNotIn('!check', recipe)
            self.assertIn('COPY --from=openssl-security /security-packages', docker)

    def test_alpine_openssl_backport_assessment_never_covers_old_or_unrelated_packages(self):
        vex = pathlib.Path(__file__).resolve().parents[2] / 'apps/api/security/alpine-openssl.openvex.json'
        policy = json.loads(vex.read_text())
        self.assertTrue(all(s['status'] == 'fixed' and '5e6d18a5ba2eec060b34a671a43ee54a5e72714a' in s['action_statement'] for s in policy['statements']))
        for version, cve, distro, assessed in [
            ('3.5.9-r1', 'CVE-2026-95692', '3.24.4', True),
            ('3.5.9-r1', 'CVE-2026-107496', '3.24.3', True),
            ('3.5.9-r0', 'CVE-2026-95692', '3.24.4', False),
            ('3.5.9-r1', 'CVE-2026-other', '3.24.4', False),
            ('3.5.9-r1', 'CVE-2026-95692', '3.23.8', False),
        ]:
            with self.subTest(version=version, cve=cve, distro=distro):
                sbom, raw = fixture()
                artifact = sbom['artifacts'][0]
                artifact.update(name='libssl3', type='apk', version=version,
                    purl=f'pkg:apk/alpine/libssl3@{version}?arch=x86_64&distro=alpine-{distro}&upstream=openssl')
                raw['matches'][0]['artifact'] = copy.deepcopy(artifact)
                raw['matches'][0]['vulnerability']['id'] = cve
                sbom['distro'] = {'id': 'alpine', 'versionID': distro}
                result = scan.normalize(sbom, raw, [str(vex)])['Results'][0]
                self.assertEqual(not result['Vulnerabilities'], assessed)
