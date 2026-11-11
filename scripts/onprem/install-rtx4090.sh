#!/usr/bin/env bash
# Native Ubuntu / one RTX 4090. May install a driver and resume after one reboot.
set -euo pipefail
plain=0
forwarded=()
for option in "$@"; do
  if [ "$option" = --no-tui ]; then plain=1; else forwarded+=("$option"); fi
done
set -- "${forwarded[@]}"
if [ "${VIDEOQ_NONINTERACTIVE:-0}" = 1 ]; then
  sudo() { command sudo -n "$@"; }
fi
for argument in "$@"; do
  case "$argument" in
    -h|--help)
      cat <<'USAGE'
Usage: bash scripts/onprem/install-rtx4090.sh [options]
Ubuntu 22.04/24.04 amd64, one RTX 4090, native K3s and interactive administrator setup.
  --no-tui               Use plain terminal mode (default: Textual setup screen)
  --directory PATH       Private installation state (default ~/.local/share/videoq-rtx4090)
  --username NAME        Initial administrator (otherwise prompted)
  --email ADDRESS        Initial administrator email (otherwise prompted)
  --url URL              Browser HTTPS URL (default detected LAN IPv4)
  --listen-ip IPV4       Local listener IP (does not configure NIC or DHCP)
  --tls-mode MODE        internal (default) / provided / acme
  --tls-cert PATH        PEM full certificate chain for provided mode
  --tls-key PATH         PEM private key for provided mode
  --tls-ca PATH          Optional root CA PEM for HTTPS verification
  --storage-gib NUMBER   Media PVC size on first installation (default 40)
  --adopt-existing       Explicitly use this dedicated host's existing K3s
  --run-id ID            Select a reviewed successful runtime release
  --source-sha SHA       Bind the selected release source
  --migrate-url          Explicitly migrate URL/CORS, preserving data and keys
  --reset-admin-link     Explicitly reissue an administrator setup/recovery link
USAGE
      exit 0 ;;
  esac
done
if [ "$(id -u)" = 0 ]; then
  echo 'sudoを付けず、通常ユーザーで bash scripts/onprem/install-rtx4090.sh を実行してください。必要なOS操作だけsudoを使います。' >&2
  exit 1
fi
. /etc/os-release
if [ "$ID" != ubuntu ] || { [ "$VERSION_ID" != 22.04 ] && [ "$VERSION_ID" != 24.04 ]; } || [ "$(uname -m)" != x86_64 ]; then
  echo 'Ubuntu 22.04/24.04 amd64 の専用GPUホストが必要です。' >&2; exit 1
fi
umask 077
# The host has one GPU and one cluster; exclude overlap even across state directories.
mkdir -p "$HOME/.cache/videoq"
chmod 700 "$HOME/.cache/videoq"
exec 9>"$HOME/.cache/videoq/rtx4090.lock"
flock -n 9 || { echo '別の RTX 4090 インストーラーが実行中です。' >&2; exit 1; }
if ! command -v curl >/dev/null || ! command -v git >/dev/null || ! command -v python3 >/dev/null || ! command -v gpg >/dev/null || ! command -v openssl >/dev/null || ! command -v ip >/dev/null; then
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y curl git python3 ca-certificates gnupg openssl iproute2
fi
source_path="${BASH_SOURCE[0]:-}"
source_root=''
if [ -n "$source_path" ] && [ -f "$source_path" ]; then
  source_root="$(cd -- "$(dirname -- "$source_path")/../.." && pwd)"
fi
if [ -z "$source_root" ] || [ ! -f "$source_root/scripts/onprem/rtx4090.py" ]; then
  source_root="${VIDEOQ_SOURCE_DIR:-$HOME/.local/share/videoq-rtx4090-src}"
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
if [ "$plain" = 0 ] && [ -t 1 ] && { true </dev/tty; } 2>/dev/null; then
  tui_venv="$HOME/.local/share/videoq-setup-tui"
  if [ ! -x "$tui_venv/bin/python" ]; then
    if ! python3 -m venv "$tui_venv"; then
      sudo apt-get update
      sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv
      python3 -m venv "$tui_venv"
    fi
  fi
  if ! "$tui_venv/bin/python" -c 'import importlib.metadata; assert importlib.metadata.version("textual") == "8.2.8"' 2>/dev/null; then
    "$tui_venv/bin/python" -m pip install --disable-pip-version-check -r "$source_root/scripts/onprem/requirements-tui.txt"
  fi
  # The actual bootstrap subprocess owns the host lock, not an idle settings screen.
  flock -u 9
  exec 9>&-
  exec "$tui_venv/bin/python" "$source_root/scripts/onprem/rtx4090_tui.py" "$@" </dev/tty
fi
# Persist only username/email and GitHub CLI's own authentication before a possible reboot.
if [ "${VIDEOQ_NONINTERACTIVE:-0}" != 1 ] && { true </dev/tty; } 2>/dev/null; then
  python3 "$source_root/scripts/onprem/rtx4090.py" "$@" --prepare-only </dev/tty
else
  python3 "$source_root/scripts/onprem/rtx4090.py" "$@" --prepare-only
fi
install_dir="$(python3 - "$@" <<'PY'
import argparse,pathlib,sys
p=argparse.ArgumentParser(add_help=False); p.add_argument('--directory',default=str(pathlib.Path.home()/'.local/share/videoq-rtx4090'))
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
    sudo apt-get update
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y ubuntu-drivers-common linux-headers-"$(uname -r)"
    sudo env DEBIAN_FRONTEND=noninteractive ubuntu-drivers install
    printf '%s\n' "$boot_id" > "$install_dir/driver-boot-id"
  fi
  if ! driver_ok; then
    if ! sudo -n -l 2>/dev/null | grep -Eq 'NOPASSWD:[[:space:]]*ALL'; then
      echo 'ドライバー反映に再起動が必要です。sudo認証を保存せず、再起動・SSH再接続後に同じコマンドで再開してください。'
      echo 'sudo reboot'
      exit 75
    fi
    python3 - "$install_dir" "$source_root/scripts/onprem/install-rtx4090.sh" "$@" <<'PY'
import json,pathlib,sys,pwd,os,tempfile,subprocess
folder=pathlib.Path(sys.argv[1]); argv=['/bin/bash',sys.argv[2],*sys.argv[3:]]
(folder/'resume-command.json').write_text(json.dumps(argv))
runner=folder/'resume-driver.py'
runner.write_text('import json,pathlib,subprocess,sys\np=pathlib.Path('+repr(str(folder))+')\nwith (p/"install.log").open("a") as log:\n r=subprocess.run(json.loads((p/"resume-command.json").read_text()),stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)\nsys.exit(r.returncode)\n')
unit=pathlib.Path('/etc/systemd/system/videoq-rtx4090-resume.service')
unit_text='[Unit]\nDescription=Resume VideoQ GPU installation after driver reboot\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=oneshot\nUser='+pwd.getpwuid(os.getuid()).pw_name+'\nEnvironment=HOME='+str(pathlib.Path.home())+'\nExecStart=/usr/bin/python3 '+str(runner)+'\nTimeoutStartSec=0\n[Install]\nWantedBy=multi-user.target\n'
with tempfile.TemporaryDirectory() as tmp:
 staged=pathlib.Path(tmp)/unit.name; staged.write_text(unit_text)
 subprocess.run(['sudo','--','install','-m','0644',str(staged),str(unit)],check=True)
PY
    sudo systemctl daemon-reload
    sudo systemctl enable videoq-rtx4090-resume.service
    echo "ドライバー反映のため再起動し、起動後に自動で導入を続けます。進捗: $install_dir/install.log"
    sudo systemctl reboot
    exit 0
  fi
fi
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com -o "$install_dir/install-docker.sh"
  sudo sh "$install_dir/install-docker.sh"
fi
sudo systemctl enable --now docker
if ! command -v nvidia-container-runtime >/dev/null; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey -o "$install_dir/nvidia-gpgkey"
  gpg --dearmor --yes -o "$install_dir/nvidia-keyring.gpg" "$install_dir/nvidia-gpgkey"
  sudo install -m 0644 "$install_dir/nvidia-keyring.gpg" /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > "$install_dir/nvidia-container-toolkit.list"
  sudo install -m 0644 "$install_dir/nvidia-container-toolkit.list" /etc/apt/sources.list.d/nvidia-container-toolkit.list
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y nvidia-container-toolkit
fi
if ! sudo docker info --format '{{json .Runtimes}}' | python3 -c 'import json,sys; sys.exit(0 if "nvidia" in json.load(sys.stdin) else 1)'; then
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
fi
if [ "${VIDEOQ_BOOTSTRAP_ONLY:-0}" = 1 ]; then
  rm -f -- "$install_dir/driver-boot-id"
  exit 0
fi
if [ "${VIDEOQ_NONINTERACTIVE:-0}" != 1 ] && { true </dev/tty; } 2>/dev/null; then
  python3 "$source_root/scripts/onprem/rtx4090.py" "$@" </dev/tty
else
  python3 "$source_root/scripts/onprem/rtx4090.py" "$@"
fi
rm -f -- "$install_dir/driver-boot-id"
if [ -f /etc/systemd/system/videoq-rtx4090-resume.service ]; then
  sudo systemctl disable videoq-rtx4090-resume.service
fi
