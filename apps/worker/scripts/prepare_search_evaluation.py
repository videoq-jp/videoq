"""Repository wrapper for the installed worker's isolated evaluation command."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker_python.search_evaluation import cli

if __name__ == "__main__":
    sys.exit(cli())
