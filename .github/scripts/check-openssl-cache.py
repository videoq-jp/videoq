"""Verify real OpenSSL compilation vertices, never infer reuse from elapsed time."""
import re
from pathlib import Path


def compiled(path):
    text = Path(path).read_text()
    vertices = re.findall(r'^#(\d+) \[openssl-security[^\]]*\] RUN .*abuild-keygen', text, re.M)
    if len(set(vertices)) != 1:
        raise ValueError(f'Expected one OpenSSL compiler vertex: {path}')
    vertex = vertices[0]
    if re.search(rf'^#{vertex} CACHED$', text, re.M):
        return False
    if not re.search(rf'^#{vertex} DONE ', text, re.M):
        raise ValueError(f'OpenSSL compiler did not complete: {path}')
    return True


def check(directory, variant):
    directory = Path(directory)
    values = {f'{run}/{component}': compiled(directory / run / f'{component}.log')
              for run in ['run-1', 'run-2'] for component in ['api', 'web']}
    expected = {'run-1/api': True, 'run-1/web': variant == 'baseline', 'run-2/api': False, 'run-2/web': False}
    if values != expected:
        raise ValueError(f'Unexpected real compiler cache behavior: {values}, expected {expected}')
    return values


if __name__ == '__main__':
    import sys, json
    print(json.dumps(check(sys.argv[1], sys.argv[2]), indent=2))
