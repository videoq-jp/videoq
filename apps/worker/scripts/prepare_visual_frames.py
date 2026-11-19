"""Backfill one uploaded video's visual cache without transcription/embedding calls."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from worker_python.tasks.visual_preparation import prepare_visuals


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video-id", type=int, required=True)
    parser.add_argument("--dry-run", action="store_true", help="Inspect source/duration without queuing jobs or writing caches")
    args = parser.parse_args()
    try:
        result = prepare_visuals(args.video_id, dry_run=args.dry_run)
    except ValueError as error:
        parser.error(str(error))
    print(" ".join(f"{key}={value}" for key, value in result.items()))


if __name__ == "__main__":
    main()
