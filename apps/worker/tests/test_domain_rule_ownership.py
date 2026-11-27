import ast
import json
from pathlib import Path

ROOT = Path(__file__).parents[3]


def test_worker_rules_have_one_implementation_and_explicit_consumers():
    catalog = json.loads((ROOT / 'docs/architecture/domain-rule-ownership.json').read_text())
    sources = {str(p.relative_to(ROOT)): ast.parse(p.read_text()) for p in (ROOT / 'apps/worker/worker_python').rglob('*.py')}
    for entry in catalog['rules']:
        for rule in entry['rules']:
            if not rule['path'].endswith('.py'):
                continue
            for symbol in rule['symbols']:
                owners = [path for path, tree in sources.items() if any(isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == symbol for node in tree.body)]
                assert owners == [rule['path']], (symbol, owners)
            module = rule['path'].removeprefix('apps/worker/').removesuffix('.py').replace('/', '.')
            for consumer in rule['consumers']:
                assert any(isinstance(node, ast.ImportFrom) and node.module == module for node in ast.walk(sources[consumer])), consumer
