#!/usr/bin/env python3
"""Catalog once with Syft, scan with Grype, retain raw evidence and policy view.

The policy view keeps the existing runtime assessors' inventory contract. Raw
Grype and Syft JSON remain authoritative and are never filtered or overwritten.
"""
import argparse
import base64
from datetime import datetime, timezone
import json
import os
import pathlib
import subprocess
from urllib.parse import parse_qsl, urlencode


def policy_purl(value):
    """Upstream source hints do not change binary package identity."""
    if not value or '?' not in value:
        return value
    base, query = value.split('?', 1)
    qualifiers = [(k, v) for k, v in parse_qsl(query) if k != 'upstream']
    return base + ('?' + urlencode(qualifiers) if qualifiers else '')


def normalize(sbom, raw, vex_paths=()):
    if not isinstance(sbom.get('artifacts'), list) or not isinstance(raw.get('matches'), list):
        raise ValueError('Incomplete Syft/Grype report')
    if raw.get('ignoredMatches'):
        raise ValueError('Unexpected scanner suppressions')
    source = sbom['source']
    expected_source = {'type': source['type'], 'target': source['metadata'] if source['type'] == 'image' else source['metadata']['path']}
    if raw.get('source') != expected_source:
        raise ValueError('Grype source differs from cataloged source')
    distro = sbom.get('distro') or {}
    metadata = source.get('metadata') or {}
    config = json.loads(base64.b64decode(metadata['config'])) if source['type'] == 'image' else {}
    groups = {}

    def group(artifact):
        os_package = artifact['type'] in ('deb', 'rpm', 'apk', 'alpm')
        kind = distro.get('id', 'unknown') if os_package else {'python': 'python-pkg'}.get(artifact['type'], artifact['type'])
        key = ('os-pkgs' if os_package else 'lang-pkgs', kind)
        return groups.setdefault(key, {'Class': key[0], 'Type': key[1], 'Packages': [], 'Vulnerabilities': []})

    artifacts = {a['id']: a for a in sbom['artifacts']}
    for a in artifacts.values():
        group(a)['Packages'].append({'Name': a['name'], 'Version': a['version'],
            'Identifier': {'PURL': policy_purl(a.get('purl'))},
            # Do not assert pip-vendor provenance without an actual SBOM cataloger.
            'Locations': sorted({loc['path'] for loc in a.get('locations', [])}),
            'AnalyzedBy': 'sbom' if 'sbom' in a.get('foundBy', '') else a.get('foundBy')})
    statements = [(path, statement) for path in vex_paths
                  for statement in json.loads(pathlib.Path(path).read_text())['statements']]
    for match in raw['matches']:
        a, v = match['artifact'], match['vulnerability']
        if a['id'] not in artifacts or any(a.get(k) != artifacts[a['id']].get(k) for k in ('name', 'version', 'purl', 'type')):
            raise ValueError('Finding does not match cataloged artifact')
        severity = v['severity'].upper()
        if severity == 'NEGLIGIBLE':
            severity = 'LOW'
        if severity not in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN'):
            raise ValueError('Unrecognized vulnerability severity')
        finding = {'Severity': severity, 'PkgName': a['name'], 'InstalledVersion': a['version'],
                   'VulnerabilityID': v['id'],
                   'Aliases': sorted({v['id']} | {related['id'] for related in match.get('relatedVulnerabilities', [])}),
                   'Locations': sorted({loc['path'] for loc in a.get('locations', [])}), 'PkgIdentifier': {'PURL': policy_purl(a.get('purl'))},
                   'FixedVersion': ', '.join(v.get('fix', {}).get('versions') or [])}
        result = group(a)
        assessment = next(((path, s) for path, s in statements
            if s['vulnerability']['name'] == v['id'] and (s['status'] == 'fixed' or (s['status'] == 'not_affected'
            and s.get('justification') in ('vulnerable_code_not_present', 'vulnerable_code_not_in_execute_path')))
            and a.get('purl') and any(policy_purl(p['@id']) == policy_purl(a['purl']) for p in s['products'])), None)
        if assessment:
            path, s = assessment
            result.setdefault('ExperimentalModifiedFindings', []).append({'Finding': finding,
                'Type': 'vulnerability', 'Status': s['status'], 'Statement': s.get('justification', 'fixed'), 'Source': path})
        else:
            result['Vulnerabilities'].append(finding)
    digests = metadata.get('repoDigests', [])
    digests = list(dict.fromkeys(digests + [d.removeprefix('index.docker.io/').removeprefix('docker.io/') for d in digests]))
    return {'SchemaVersion': 2, 'Scanner': 'Grype',
        'ArtifactType': 'container_image' if source['type'] == 'image' else 'filesystem',
        'ArtifactName': metadata.get('path') or source.get('name'),
        'Metadata': {'RepoDigests': digests,
            'OS': {'Family': distro.get('id'), 'Name': distro.get('versionID')},
            'ImageConfig': config}, 'Results': list(groups.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--platform', default='')
    parser.add_argument('--policy', default='')
    parser.add_argument('--gate', choices=['strict', 'assess'], default='strict')
    args = parser.parse_args()
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    inventory, raw_path = str(output) + '.syft.json', str(output) + '.grype.json'
    env = dict(os.environ, SYFT_CHECK_FOR_APP_UPDATE='false', GRYPE_CHECK_FOR_APP_UPDATE='false')
    # Explicit empty configs prevent ambient ignores/exclusions from changing CI.
    config = output.parent / (output.name + '.scanner.yaml')
    config.write_text('match-upstream-kernel-headers: true\nignore: []\n')
    command = ['syft', args.source, '--config', str(config), '-o', 'syft-json=' + inventory]
    if args.platform:
        command += ['--platform', args.platform]
    subprocess.run(command, check=True, env=env)
    subprocess.run(['grype', 'sbom:' + inventory, '--config', str(config), '-o', 'json', '--file', raw_path], check=True, env=env)
    policy = json.loads(pathlib.Path(args.policy).read_text()) if args.policy else {}
    if policy.get('expiresAt') and datetime.now(timezone.utc) >= datetime.fromisoformat(policy['expiresAt'].replace('Z', '+00:00')):
        raise ValueError('Scanner assessment expired')
    report = normalize(json.loads(pathlib.Path(inventory).read_text()), json.loads(pathlib.Path(raw_path).read_text()), policy.get('vex', []))
    output.write_text(json.dumps(report, indent=2) + '\n')
    if args.gate == 'strict' and any(v['Severity'] in ('HIGH', 'CRITICAL') for r in report['Results'] for v in r['Vulnerabilities']):
        for result in report['Results']:
            for finding in result['Vulnerabilities']:
                if finding['Severity'] in ('HIGH', 'CRITICAL'):
                    print(json.dumps(finding), flush=True)
        raise SystemExit('Unassessed HIGH/CRITICAL vulnerabilities (including unfixed)')


if __name__ == '__main__':
    main()
