"""Compare repeated fresh/warm groups without inventing a currency price."""
import argparse
import json
from pathlib import Path
from statistics import mean


def summarize(reports):
    if len(reports) != 4 or len({report['source'] for report in reports}) != 1:
        raise ValueError('Require four reports for exactly one candidate SHA')
    groups = {}
    for parallelism in [1, 2]:
        selected = [report for report in reports if report['parallelism'] == parallelism]
        if len(selected) != 2:
            raise ValueError('Require two independent runners per strategy')
        for report in selected:
            if report['failedBuilds'] or len(report['runs']) != 2 or not all(report['cacheControl'][key] for key in ['sameInputReused', 'changedInputInvalidated']):
                raise ValueError('Failed/incomplete build or cache validation cannot support adoption')
        groups[str(parallelism)] = {
            'coldSeconds': [report['runs'][0]['seconds'] for report in selected],
            'warmSeconds': [report['runs'][1]['seconds'] for report in selected],
            'measuredBuildRunnerSeconds': sum(report['seconds'] for report in selected),
            'failedBuilds': sum(report['failedBuilds'] for report in selected),
            'minDiskFreeBytes': min(sample['diskFreeBytes'] for report in selected for sample in [report['before'], report['after'], *report['resourceSamples']]),
        }
    baseline, candidate = groups['1'], groups['2']
    return {'source': reports[0]['source'], 'strategies': groups,
        'coldMeanRatio': mean(candidate['coldSeconds']) / mean(baseline['coldSeconds']),
        'warmMeanRatio': mean(candidate['warmSeconds']) / mean(baseline['warmSeconds']),
        'costUnit': 'measured build runner seconds; monetary rate is account-specific',
        'scope': 'two independent cold runners and two warm repeats per strategy; assess memory/load evidence, variance and full-job scan/smoke outcomes before adoption'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = summarize([json.loads(path.read_text()) for path in args.directory.rglob('result.json')])
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
