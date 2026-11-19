"""Keep extracted application workflows free of runtime and adapter dependencies."""
import ast
from pathlib import Path


ALLOWED_IMPORTS = {
    "__future__", "logging", "dataclasses", "typing", "worker_python.video_status",
}


def test_use_cases_import_only_pure_contracts_and_standard_helpers():
    directory = Path(__file__).parents[1] / "worker_python" / "use_cases"
    for path in directory.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert all(alias.name in ALLOWED_IMPORTS for alias in node.names), path
            elif isinstance(node, ast.ImportFrom):
                assert node.level == 0 and node.module in ALLOWED_IMPORTS, path
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                assert node.func.id != "__import__", path
