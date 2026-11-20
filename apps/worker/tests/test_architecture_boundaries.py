"""Keep extracted application workflows free of runtime and adapter dependencies."""
import ast
from pathlib import Path


ALLOWED_IMPORTS = {
    "__future__", "logging", "math", "json", "dataclasses", "typing", "re", "uuid", "enum", "collections.abc",
}


def test_use_cases_import_only_pure_contracts_and_standard_helpers():
    package = Path(__file__).parents[1] / "worker_python"
    paths = [path for name in ("use_cases", "domain") for path in (package / name).rglob("*.py")]
    pure_modules = {"worker_python." + ".".join(path.relative_to(package).with_suffix("").parts) for path in paths}
    for path in paths:
        allowed = ALLOWED_IMPORTS | {name for name in pure_modules if not path.is_relative_to(package / "domain") or name.startswith("worker_python.domain.")}
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert all(alias.name in allowed for alias in node.names), path
            elif isinstance(node, ast.ImportFrom):
                assert node.level == 0 and node.module in allowed, path
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                assert node.func.id != "__import__", path
