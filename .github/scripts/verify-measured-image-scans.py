"""Reject any rebuild or retag between a paired measurement, runtime smoke and scan."""
import argparse
import json
from pathlib import Path
import subprocess


def verify(report, directory, current):
    if report['failedBuilds']:
        raise ValueError('Failed measured builds cannot satisfy image checks')
    smoke = json.loads((directory / 'smoke-image-ids.json').read_text())
    results = []
    for component in report['runs'][-1]['components']:
        name, expected = component['component'], component['imageId']
        tag = f'videoq-{name}:onprem-ci'
        matched = [image for image in smoke if tag in image.get('RepoTags', [])]
        final = [image for image in current if tag in image.get('RepoTags', [])]
        scanned = json.loads((directory / f'{name}-security.json.syft.json').read_text())['source']['metadata']
        if len(matched) != 1 or len(final) != 1 or matched[0]['Id'] != expected or final[0]['Id'] != expected or scanned['imageID'] != expected:
            raise ValueError('Measured/smoked/scanned image identity mismatch: ' + name)
        results.append({'component': name, 'imageId': expected, 'smokeMatches': True, 'scanMatches': True, 'unchangedAfterChecks': True})
    if {row['component'] for row in results} != {'api','worker','web'}:
        raise ValueError('Incomplete measured image checks')
    return {'source': report['source'], 'dockerfileVariant': report['dockerfileVariant'], 'images': results}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    current = json.loads(subprocess.check_output(['docker','image','inspect','videoq-api:onprem-ci','videoq-worker:onprem-ci','videoq-web:onprem-ci'],text=True))
    print(json.dumps(verify(json.loads(args.report.read_text()), args.directory, current),indent=2))
