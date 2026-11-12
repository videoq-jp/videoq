#!/usr/bin/env bash
# User-owned verification environment. No GitHub CLI, credentials or login.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
destination="$HOME/.local/share/videoq-verifier"
if [ ! -x "$destination/bin/python" ]; then
  if ! python3 -m venv "$destination"; then
    sudo apt-get update
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv
    python3 -m venv "$destination"
  fi
fi
if ! "$destination/bin/python" -c 'import importlib.metadata; assert importlib.metadata.version("sigstore") == "4.5.1"' 2>/dev/null; then
  "$destination/bin/python" -m pip install --disable-pip-version-check -r "$root/scripts/onprem/requirements-verify.txt"
fi
