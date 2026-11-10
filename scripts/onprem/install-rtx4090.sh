#!/usr/bin/env bash
# Native Ubuntu / one RTX 4090. May install a driver and resume after one reboot.
set -euo pipefail
for argument in "$@"; do
  case "$argument" in
    -h|--help)
      cat <<'USAGE'
Usage: sudo bash scripts/onprem/install-rtx4090.sh [options]
Ubuntu 22.04/24.04 amd64, one RTX 4090, native K3s and interactive administrator setup.
  --directory PATH       Private installation state (default /root/videoq-rtx4090)
  --username NAME        Initial administrator (otherwise prompted)
  --email ADDRESS        Initial administrator email (otherwise prompted)
  --url URL              SSH origin (default http://localhost:8080)
  --storage-gib NUMBER   Media PVC size on first installation (default 40)
  --adopt-existing       Explicitly use this dedicated host's existing K3s
  --run-id ID            Select a reviewed successful runtime release
  --source-sha SHA       Bind the selected release source
  --reset-admin-link     Explicitly reissue an administrator setup/recovery link
USAGE
      exit 0 ;;
  esac
done
if [ "$(id -u)" != 0 ]; then
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    exec sudo --preserve-env=GH_TOKEN,GITHUB_TOKEN,VIDEOQ_SOURCE_REF,VIDEOQ_SOURCE_DIR bash "${BASH_SOURCE[0]}" "$@"
  fi
  echo 'root のシェルで実行してください（またはファイルに保存して sudo bash で実行）。' >&2; exit 1
fi
. /etc/os-release
if [ "$ID" != ubuntu ] || { [ "$VERSION_ID" != 22.04 ] && [ "$VERSION_ID" != 24.04 ]; } || [ "$(uname -m)" != x86_64 ]; then
  echo 'Ubuntu 22.04/24.04 amd64 の専用GPUホストが必要です。' >&2; exit 1
fi
umask 077
# The host has one GPU and one cluster; exclude overlap even across state directories.
exec 9>/run/lock/videoq-rtx4090.lock
flock -n 9 || { echo '別の RTX 4090 インストーラーが実行中です。' >&2; exit 1; }
if ! command -v curl >/dev/null || ! command -v git >/dev/null || ! command -v python3 >/dev/null || ! command -v gpg >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl git python3 ca-certificates gnupg
fi
source_path="${BASH_SOURCE[0]:-}"
source_root=''
if [ -n "$source_path" ] && [ -f "$source_path" ]; then
  source_root="$(cd -- "$(dirname -- "$source_path")/../.." && pwd)"
fi
if [ -z "$source_root" ] || [ ! -f "$source_root/scripts/onprem/rtx4090.py" ]; then
  source_root="${VIDEOQ_SOURCE_DIR:-/opt/videoq-rtx4090-src}"
  if [ -e "$source_root" ] && [ ! -d "$source_root/.git" ]; then
    echo 'ソース取得先が既存の別ディレクトリです。VIDEOQ_SOURCE_DIR を変更してください。' >&2; exit 1
  fi
  if [ ! -d "$source_root/.git" ]; then
    git init "$source_root"
    git -C "$source_root" remote add origin https://github.com/videoq-jp/videoq.git
    git -C "$source_root" fetch --depth=1 origin "${VIDEOQ_SOURCE_REF:-main}"
    git -C "$source_root" checkout --detach FETCH_HEAD
  fi
fi
if [ ! -f "$source_root/scripts/onprem/rtx4090.py" ]; then
  echo '指定したソース版に RTX 4090 インストーラーがありません。VIDEOQ_SOURCE_REF を確認してください。' >&2; exit 1
fi
export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"
# Persist only username/email and GitHub CLI's own authentication before a possible reboot.
if { true </dev/tty; } 2>/dev/null; then
  python3 "$source_root/scripts/onprem/rtx4090.py" "$@" --prepare-only </dev/tty
else
  python3 "$source_root/scripts/onprem/rtx4090.py" "$@" --prepare-only
fi
install_dir="$(python3 - "$@" <<'PY'
import argparse,pathlib,sys
p=argparse.ArgumentParser(add_help=False); p.add_argument('--directory',default='/root/videoq-rtx4090')
a,_=p.parse_known_args(); print(pathlib.Path(a.directory).expanduser().resolve())
PY
)"
driver_ok() {
  python3 - <<'PY'
import shutil,subprocess,sys
if not shutil.which('nvidia-smi'): sys.exit(1)
p=subprocess.run(['nvidia-smi','--query-gpu=driver_version','--format=csv,noheader'],capture_output=True,text=True)
try: ok=p.returncode==0 and all(tuple(map(int,v.strip().split('.'))) >= (580,65,6) for v in p.stdout.splitlines()) and bool(p.stdout.strip())
except ValueError: ok=False
sys.exit(0 if ok else 1)
PY
}
if ! driver_ok; then
  boot_id="$(cat /proc/sys/kernel/random/boot_id)"
  if [ -f "$install_dir/driver-boot-id" ] && [ "$(cat "$install_dir/driver-boot-id")" != "$boot_id" ]; then
    echo '再起動後もNVIDIAドライバーを使用できません。GPUパススルー・Secure Boot・ドライバーモジュールを確認してください。再起動を繰り返しません。' >&2; exit 1
  fi
  if [ ! -f "$install_dir/driver-boot-id" ]; then
    python3 - <<'PY'
from pathlib import Path
cards=[p for p in Path('/sys/bus/pci/devices').glob('*') if (p/'vendor').read_text().strip()=='0x10de' and (p/'device').read_text().strip()=='0x2684']
if len(cards)!=1: raise SystemExit('RTX 4090 (PCI 10de:2684) が1枚ある必要があります')
PY
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ubuntu-drivers-common linux-headers-"$(uname -r)"
    DEBIAN_FRONTEND=noninteractive ubuntu-drivers install
    printf '%s\n' "$boot_id" > "$install_dir/driver-boot-id"
  fi
  if ! driver_ok; then
    python3 - "$install_dir" "$source_root/scripts/onprem/install-rtx4090.sh" "$@" <<'PY'
import json,pathlib,sys
folder=pathlib.Path(sys.argv[1]); argv=['/bin/bash',sys.argv[2],*sys.argv[3:]]
(folder/'resume-command.json').write_text(json.dumps(argv))
runner=folder/'resume-driver.py'
runner.write_text('import json,pathlib,subprocess,sys\np=pathlib.Path('+repr(str(folder))+')\nwith (p/"install.log").open("a") as log:\n r=subprocess.run(json.loads((p/"resume-command.json").read_text()),stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)\nsys.exit(r.returncode)\n')
unit=pathlib.Path('/etc/systemd/system/videoq-rtx4090-resume.service')
unit.write_text('[Unit]\nDescription=Resume VideoQ GPU installation after driver reboot\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 '+str(runner)+'\nTimeoutStartSec=0\n[Install]\nWantedBy=multi-user.target\n')
PY
    systemctl daemon-reload
    systemctl enable videoq-rtx4090-resume.service
    echo "ドライバー反映のため再起動し、起動後に自動で導入を続けます。進捗: $install_dir/install.log"
    systemctl reboot
    exit 0
  fi
fi
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com -o "$install_dir/install-docker.sh"
  sh "$install_dir/install-docker.sh"
fi
systemctl enable --now docker
if ! command -v nvidia-container-runtime >/dev/null; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey -o "$install_dir/nvidia-gpgkey"
  gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg "$install_dir/nvidia-gpgkey"
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nvidia-container-toolkit
fi
if ! docker info --format '{{json .Runtimes}}' | python3 -c 'import json,sys; sys.exit(0 if "nvidia" in json.load(sys.stdin) else 1)'; then
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker
fi
if { true </dev/tty; } 2>/dev/null; then
  python3 "$source_root/scripts/onprem/rtx4090.py" "$@" </dev/tty
else
  python3 "$source_root/scripts/onprem/rtx4090.py" "$@"
fi
rm -f -- "$install_dir/driver-boot-id"
if [ -f /etc/systemd/system/videoq-rtx4090-resume.service ]; then
  systemctl disable videoq-rtx4090-resume.service
fi
