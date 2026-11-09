#!/usr/bin/env bash
# Install the operator tools separately from disposable VideoQ environments.
set -euo pipefail
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) arch=amd64 ;;
  Linux-aarch64) arch=arm64 ;;
  *) echo 'This installer supports Linux amd64 and arm64.' >&2; exit 1 ;;
esac
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
destination="${VIDEOQ_TOOLS_DIR:-$HOME/.local/bin}"
workspace="$(mktemp -d)"
trap 'rm -r -- "$workspace"' EXIT
mkdir -p "$destination"
verify() {
  python3 - "$1" "$2" "$3" <<'PY'
import hashlib, sys
from pathlib import Path
binary, checksums, name = sys.argv[1:]
expected = []
for line in Path(checksums).read_text().splitlines():
    parts = line.split()
    if len(parts) == 2 and Path(parts[1].lstrip('*')).name == name:
        expected.append(parts[0])
actual = hashlib.sha256(Path(binary).read_bytes()).hexdigest()
if expected != [actual]:
    raise SystemExit(f'Checksum mismatch: {name}')
PY
}
# k3d (K3s in Docker)
k3d_version=5.9.0
python3 "$root/.github/scripts/package-managers.py" github-asset \
  --url "https://github.com/k3d-io/k3d/releases/download/v${k3d_version}/k3d-linux-${arch}" --output "$workspace/k3d"
python3 "$root/.github/scripts/package-managers.py" github-asset \
  --url "https://github.com/k3d-io/k3d/releases/download/v${k3d_version}/checksums.txt" --output "$workspace/k3d-checksums.txt"
verify "$workspace/k3d" "$workspace/k3d-checksums.txt" "k3d-linux-${arch}"
# kubectl matches the minor version of the documented K3s node.
kubectl_version=1.35.5
curl -fsSL "https://dl.k8s.io/release/v${kubectl_version}/bin/linux/${arch}/kubectl" -o "$workspace/kubectl"
curl -fsSL "https://dl.k8s.io/release/v${kubectl_version}/bin/linux/${arch}/kubectl.sha256" -o "$workspace/kubectl.sha256"
python3 - "$workspace" <<'PY'
import hashlib, sys
from pathlib import Path
root = Path(sys.argv[1])
if hashlib.sha256((root / 'kubectl').read_bytes()).hexdigest() != (root / 'kubectl.sha256').read_text().strip():
    raise SystemExit('Checksum mismatch: kubectl')
PY
# Reuse the repository's pinned Helm version and checksums.
HELM_INSTALL_DIR="$workspace/helm-tools" bash "$root/.github/scripts/install-helm.sh"
# gh must support attestation verification, unlike older Ubuntu packages.
gh_version=2.103.3
gh_archive="gh_${gh_version}_linux_${arch}.tar.gz"
python3 "$root/.github/scripts/package-managers.py" github-asset \
  --url "https://github.com/cli/cli/releases/download/v${gh_version}/${gh_archive}" --output "$workspace/$gh_archive"
python3 "$root/.github/scripts/package-managers.py" github-asset \
  --url "https://github.com/cli/cli/releases/download/v${gh_version}/gh_${gh_version}_checksums.txt" --output "$workspace/gh-checksums.txt"
verify "$workspace/$gh_archive" "$workspace/gh-checksums.txt" "$gh_archive"
tar -xzf "$workspace/$gh_archive" -C "$workspace" "gh_${gh_version}_linux_${arch}/bin/gh"
install -m 0755 "$workspace/k3d" "$destination/k3d"
install -m 0755 "$workspace/kubectl" "$destination/kubectl"
install -m 0755 "$workspace/helm-tools/helm" "$destination/helm"
install -m 0755 "$workspace/gh_${gh_version}_linux_${arch}/bin/gh" "$destination/gh"
"$destination/k3d" version
"$destination/kubectl" version --client
"$destination/gh" version
printf '\nTools installed in %s\nAdd this directory to PATH in your terminal before continuing.\n' "$destination"
