"""Fail closed on unmatched same-runner controls; keep cold/warm effects separate."""
import json
from pathlib import Path
import sys


def summarize(root):
    root = Path(root)
    rows = {v: json.loads((root / v / 'build/result.json').read_text()) for v in ['baseline','candidate']}
    a, b = rows.values()
    for key in ['source', 'platform', 'parallelism', 'runnerImage', 'cpuModelNames']:
        if a[key] != b[key]:
            raise ValueError('Unmatched paired metadata: ' + key)
    for row in rows.values():
        if row['parallelism'] != 1 or row['failedBuilds'] or len(row['runs']) != 2:
            raise ValueError('Incomplete sequential cold/warm pair')
        if row['buildkitLimits'] != row['buildkitLimitsAfter']:
            raise ValueError('Builder controls changed during measurement')
        controls = row['buildkitLimits']
        if (controls['effectiveCpus'], controls['memoryBytes'], controls['memorySwapBytes']) != (4,8589934592,8589934592):
            raise ValueError('Uncontrolled effective resources')
        identity = json.loads((root / row['dockerfileVariant'] / 'checks/identity-verification.json').read_text())
        if identity['source'] != row['source'] or len(identity['images']) != 3:
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
    for key in ['parentLimits','cpuQuotaCpus','memoryMaxBytes']:
        if ca['builderHostCgroupEnvelope'][key] != cb['builderHostCgroupEnvelope'][key]:
            raise ValueError('Unmatched actual builder ancestry: '+key)
    return {'source': a['source'], 'protocol': 'same runner; distinct fresh builders; effective 4 CPU/8GiB/no swap; sequential AB or BA',
        'cold': {'baselineSeconds': a['runs'][0]['seconds'], 'candidateSeconds': b['runs'][0]['seconds'],
                 'reductionPercent': (1-b['runs'][0]['seconds']/a['runs'][0]['seconds'])*100},
        'warm': {'baselineSeconds': a['runs'][1]['seconds'], 'candidateSeconds': b['runs'][1]['seconds']},
        'buildRunnerSeconds': {v: row['seconds'] for v,row in rows.items()},
        'hostVariation': {v: row['before'] for v,row in rows.items()},
        'decision': 'per-pair evidence only; adoption requires all three pairs, scans, smokes and actual invalidation controls'}


if __name__ == '__main__':
    result = summarize(sys.argv[1])
    Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n')
