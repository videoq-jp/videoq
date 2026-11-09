#!/usr/bin/env bash
set -euo pipefail
# GitHub's official release asset SHA-256, fixed with the tool version.
version=0.33.0
if [ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]; then
  echo 'Install kind separately on this platform' >&2
  exit 1
fi
destination="${KIND_INSTALL_DIR:?Set KIND_INSTALL_DIR to a temporary tools directory}"
mkdir -p "$destination"
python3 "$(dirname "$0")/package-managers.py" github-asset \
  --url "https://github.com/kubernetes-sigs/kind/releases/download/v$version/kind-linux-amd64" --output "$destination/kind"
echo 'aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d  '"$destination/kind" | sha256sum --check
chmod +x "$destination/kind"
"$destination/kind" version
