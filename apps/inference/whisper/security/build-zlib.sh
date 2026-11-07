#!/bin/sh
set -eu

# Debian trixie has no fixed zlib package for CVE-2026-76844 yet.
# Use the complete upstream release, retaining package/source/license records.
curl -fsSL https://zlib.net/zlib-1.4.tar.gz -o /tmp/zlib.tar.gz
echo '02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584  /tmp/zlib.tar.gz' | sha256sum -c -
tar -xzf /tmp/zlib.tar.gz -C /tmp
cd /tmp/zlib-1.4
CFLAGS='-O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2' LDFLAGS='-Wl,-z,relro,-z,now' ./configure --shared
make -j2
make check
gcc -Wall -Wextra -Werror -I. /tmp/zlib-write-error.c -L. -Wl,-rpath,"$PWD" -lz -o /tmp/zlib-write-error
/tmp/zlib-write-error

arch=$(dpkg --print-architecture)
multiarch=$(gcc -dumpmachine)
root=/tmp/zlib-package
mkdir -p "$root/DEBIAN" "$root/usr/lib/$multiarch" "$root/usr/share/doc/zlib1g"
cp libz.so.1.4 "$root/usr/lib/$multiarch/libz.so.1.4"
ln -s libz.so.1.4 "$root/usr/lib/$multiarch/libz.so.1"
cat > "$root/DEBIAN/control" <<EOF
Package: zlib1g
Source: zlib
Version: 1:1.4-0videoq1
Architecture: $arch
Maintainer: VideoQ <security@videoq.jp>
Section: libs
Priority: optional
Depends: libc6 (>= 2.34)
Description: zlib 1.4 shared library built by VideoQ from official sources
 Retains the libz.so.1 ABI; no contrib libraries or command-line tools.
EOF
cp LICENSE "$root/usr/share/doc/zlib1g/copyright"
cat > "$root/usr/share/doc/zlib1g/source" <<'EOF'
Source: https://zlib.net/zlib-1.4.tar.gz
SHA256: 02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584
Build: apps/inference/whisper/security/build-zlib.sh
EOF
dpkg-deb --build "$root" /tmp/zlib1g.deb
