"""Extract a canonical commit into a fresh directory without trusting archive paths."""
import io
import re
import sys
import tarfile
import urllib.request
from pathlib import Path


def main(sha):
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("INVALID_MIGRATION_SOURCE")
    destination = Path("migration-source")
    destination.mkdir(mode=0o700)  # Never reuse a previous or partially extracted tree.
    with urllib.request.urlopen(
        f"https://codeload.github.com/videoq-jp/videoq/tar.gz/{sha}", timeout=60
    ) as response:
        content = response.read(100 * 1024 * 1024 + 1)
    if len(content) > 100 * 1024 * 1024:
        raise ValueError("SOURCE_ARCHIVE_TOO_LARGE")
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
        prefix = "videoq-" + sha + "/"
        members = []
        for member in archive.getmembers():
            if member.name == prefix[:-1]:
                continue
            if not member.name.startswith(prefix):
                raise ValueError("UNEXPECTED_SOURCE_ROOT")
            relative = member.name[len(prefix):]
            if not relative.startswith(("apps/api/", ".github/deploy-tools/")):
                continue
            if not (member.isfile() or member.isdir()):
                raise ValueError("MIGRATION_SOURCE_LINK_NOT_ALLOWED")
            member.name = relative
            members.append(member)
        archive.extractall(destination, members=members, filter="data")
    for required in ["apps/api/scripts/db-migrate.sh", "apps/api/drizzle/meta/_journal.json", ".github/deploy-tools/package-lock.json"]:
        if not (destination / required).is_file():
            raise ValueError("INCOMPLETE_MIGRATION_SOURCE")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception:
        raise SystemExit("Unable to prepare the canonical migration source") from None
