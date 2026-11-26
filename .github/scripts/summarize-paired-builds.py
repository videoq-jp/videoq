"""Fail closed on unmatched same-runner controls; keep cold/warm effects separate."""
import json
import re
from pathlib import PurePosixPath
from pathlib import Path
import sys


def corresponding_ancestry(controls):
    """Map only the selected container's exact scope; retain all other paths/limits."""
    container = controls['containerId']
    if not re.fullmatch(r'[0-9a-f]{64}', container):
        raise ValueError('Invalid selected container identity')
    envelope = controls['builderHostCgroupEnvelope']
    membership = PurePosixPath(envelope['membership'])
    scope = 'docker-' + container + '.scope'
    if (not membership.is_absolute() or '..' in membership.parts
            or membership.parts.count(scope) != 1 or membership.name != 'init'
            or membership.parent.name != scope
            or str(membership) != envelope['membership']):
        raise ValueError('Unverified selected container membership topology')
    expected = list(membership.parents)
    parents = envelope['parentLimits']
    if [entry.get('path') for entry in parents] != [str(path) for path in expected]:
        raise ValueError('Incomplete or mismatched actual ancestry topology')
    def mapped(path):
        return str(PurePosixPath(*('docker-<selected-container>.scope' if part == scope else part
                                  for part in PurePosixPath(path).parts)))
    return {**envelope, 'membership': mapped(str(membership)),
            'parentLimits': [{**entry, 'path': mapped(entry['path'])} for entry in parents]}


def summarize(root):
    root = Path(root)
    rows = {v: json.loads((root / v / 'build/result.json').read_text()) for v in ['baseline','candidate']}
    a, b = rows.values()
    for key in ['source', 'platform', 'parallelism', 'runnerImage', 'cpuModelNames']:
        if a[key] != b[key]:
            raise ValueError('Unmatched paired metadata: ' + key)
    for variant, row in rows.items():
        if row['dockerfileVariant'] != variant:
            raise ValueError('Mislabeled or duplicated fixed-directory variant: ' + variant)
        if row['parallelism'] != 1 or row['failedBuilds'] or len(row['runs']) != 2:
            raise ValueError('Incomplete sequential cold/warm pair')
        if row['buildkitLimits'] != row['buildkitLimitsAfter']:
            raise ValueError('Builder controls changed during measurement')
        controls = row['buildkitLimits']
        if (controls['effectiveCpus'], controls['memoryBytes'], controls['memorySwapBytes']) != (4,8589934592,8589934592):
            raise ValueError('Uncontrolled effective resources')
        identity = json.loads((root / variant / 'checks/identity-verification.json').read_text())
        if identity['source'] != row['source'] or identity['dockerfileVariant'] != variant or len(identity['images']) != 3:
            raise ValueError('Missing exact measured/smoked/scanned identity checks')
        for image in identity['images']:
            if not all(image[k] for k in ['smokeMatches','scanMatches','unchangedAfterChecks']):
                raise ValueError('Image identity checks failed')
    ca, cb = a['buildkitLimits'], b['buildkitLimits']
    for key in ['buildkitImage','buildkitVersion','cpus','memoryBytes','cpuPeriod','cpuQuota','memorySwapBytes','cpusetCpus','hostAllowedCpus','containerAllowedCpus','hostInheritedQuotaCpus','actualCgroupLimits']:
        if ca[key] != cb[key]:
            raise ValueError('Unmatched effective limits: '+key)
    if ca['containerId'] == cb['containerId']:
        raise ValueError('Pair must use distinct fresh builders')
    if corresponding_ancestry(ca) != corresponding_ancestry(cb):
        raise ValueError('Unmatched actual builder ancestry')
    inventories = {}
    for component in ['api', 'worker', 'web']:
        versions = {}
        for variant in ['baseline', 'candidate']:
            catalog = json.loads((root / variant / 'checks' / f'{component}-security.json.syft.json').read_text())
            versions[variant] = sorted({(p['type'], p['name'], p['version']) for p in catalog['artifacts']})
            if not versions[variant]:
                raise ValueError('Missing measured package inventory')
        if versions['baseline'] != versions['candidate']:
            raise ValueError('Resolved package versions changed between controlled variants: ' + component)
        inventories[component] = {'matchedPackageVersions': True, 'packages': len(versions['baseline'])}
    return {'source': a['source'], 'protocol': 'same runner; distinct fresh builders; effective 4 CPU/8GiB/no swap; sequential AB or BA',
        'cold': {'baselineSeconds': a['runs'][0]['seconds'], 'candidateSeconds': b['runs'][0]['seconds'],
                 'reductionPercent': (1-b['runs'][0]['seconds']/a['runs'][0]['seconds'])*100},
        'warm': {'baselineSeconds': a['runs'][1]['seconds'], 'candidateSeconds': b['runs'][1]['seconds']},
        'buildRunnerSeconds': {v: row['seconds'] for v,row in rows.items()},
        'packageInventoryComparison': inventories,
        'hostVariation': {v: row['before'] for v,row in rows.items()},
        'decision': 'per-pair evidence only; adoption requires all three pairs, scans, smokes and actual invalidation controls'}


if __name__ == '__main__':
    result = summarize(sys.argv[1])
    Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n')
