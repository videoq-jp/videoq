"""Run consumer-local negative controls; importable as an isolated pytest plugin."""
from __future__ import annotations

import ast
import hashlib
import importlib.abc
import importlib.machinery
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[3]


def pytest_sessionstart(session):
    control = os.environ.get('OWNERSHIP_PY_CONTROL')
    if not control:
        return
    row = json.loads(Path(control).read_text())
    target = (ROOT / row['consumer']).resolve()
    mode = os.environ['OWNERSHIP_MODE']

    class Mutation(ast.NodeTransformer):
        sites = 0

        def visit_Call(self, node):
            if isinstance(node.func, ast.Name) and node.func.id in row['symbols']:
                self.sites += 1
                if mode == 'baseline':
                    return node
                replacement = ast.Constant(None) if mode == 'bypass' else ast.Subscript(
                    value=ast.Tuple(elts=[node, ast.Constant(None)], ctx=ast.Load()),
                    slice=ast.Constant(1), ctx=ast.Load())
                return ast.copy_location(replacement, node)
            return self.generic_visit(node)

    class Loader(importlib.machinery.SourceFileLoader):
        def get_code(self, fullname):
            tree = ast.parse(target.read_text(), filename=str(target))
            mutation = Mutation()
            tree = mutation.visit(tree)
            Path(os.environ['OWNERSHIP_TRANSFORM_RECEIPT']).write_text(json.dumps(
                {'consumer': row['consumer'], 'mode': mode, 'sites': mutation.sites}))
            return compile(ast.fix_missing_locations(tree), str(target), 'exec')

    class Finder(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            spec = importlib.machinery.PathFinder.find_spec(fullname, path)
            if spec and spec.origin and Path(spec.origin).resolve() == (ROOT / row['consumer']).resolve():
                spec.loader = Loader(fullname, spec.origin)
                return spec
            return None

    sys.meta_path.insert(0, Finder())


def main():
    catalog = json.loads((ROOT / 'docs/architecture/ownership-behavioral-controls.json').read_text())
    output = Path(os.environ.get('OWNERSHIP_REPORT_DIR') or tempfile.mkdtemp(prefix='videoq-python-ownership-'))
    output.mkdir(parents=True, exist_ok=True)
    results = []
    sha = lambda path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
    for row in catalog['pythonControls']:
        control = output / (row['id'] + '.control.json')
        control.write_text(json.dumps(row))
        result = {**row, 'sourceSha256': sha(row['consumer']), 'ownerSha256': sha(row['owner']),
                  'testsSha256': {p: sha('apps/worker/' + p) for p in row['tests']}, 'runs': []}
        for mode in ['baseline', *row['modes']]:
            prefix = output / (row['id'] + '.' + mode)
            xml, receipt = Path(str(prefix) + '.xml'), Path(str(prefix) + '.transform.json')
            xml.unlink(missing_ok=True)
            receipt.unlink(missing_ok=True)
            env = {**os.environ, 'OWNERSHIP_PY_CONTROL': str(control), 'OWNERSHIP_MODE': mode,
                   'OWNERSHIP_TRANSFORM_RECEIPT': str(receipt),
                   'PYTHONPATH': str(Path(__file__).parent) + os.pathsep + str(ROOT / 'apps/worker')}
            run = subprocess.run([sys.executable, '-m', 'pytest', '-p', 'ownership_controls', *row['tests'],
                                  '-q', '--junitxml=' + str(xml)], cwd=ROOT / 'apps/worker', env=env,
                                 text=True, capture_output=True)
            Path(str(prefix) + '.log').write_text(run.stdout + run.stderr)
            cases = ET.parse(xml).findall('.//testcase') if xml.exists() else []
            failed = [c.attrib['name'] for c in cases if c.find('failure') is not None]
            errors = [c for c in cases if c.find('error') is not None]
            skipped = [c for c in cases if c.find('skipped') is not None]
            transformed = json.loads(receipt.read_text()) if receipt.exists() else None
            valid = transformed and transformed['sites'] > 0 and len(cases) > len(skipped) and not errors
            status = ('passed' if valid and run.returncode == 0 else 'invalid-baseline') if mode == 'baseline' else (
                'detected' if valid and run.returncode == 1 and failed else
                'survived' if valid and run.returncode == 0 else 'invalid-run')
            result['runs'].append(dict(mode=mode, status=status, exitCode=run.returncode, transformed=transformed,
                                       failedTests=failed, failed=len(failed), skipped=len(skipped),
                                       passed=len(cases)-len(failed)-len(errors)-len(skipped)))
            print(row['id'], mode, status, flush=True)
            if mode == 'baseline' and status != 'passed':
                break
        results.append(result)
        (output / 'report.json').write_text(json.dumps({'results': results}, indent=2) + '\n')
    return 0 if all(len(r['runs']) == 3 and all(x['status'] in {'passed', 'detected'} for x in r['runs']) for r in results) else 1


if __name__ == '__main__':
    raise SystemExit(main())
