#!/bin/sh
set -eu

# Debian trixie has no distribution fix for CVE-2026-76844 yet.
# Build the official fixed release and retain package/source/license metadata.
curl -fsSL https://zlib.net/fossils/zlib-1.4.tar.gz -o /tmp/zlib.tar.gz
echo '02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584  /tmp/zlib.tar.gz' | sha256sum -c -
tar -xzf /tmp/zlib.tar.gz -C /tmp
cd /tmp/zlib-1.4
CFLAGS='-O2 -fPIC -Wformat -Werror=format-security' LDFLAGS='-Wl,-z,relro,-z,now' ./configure --shared
make -j2
make test
arch=$(dpkg --print-architecture)
multiarch=$(gcc -dumpmachine)
root=/tmp/zlib-package
mkdir -p "$root/DEBIAN" "$root/usr/lib/$multiarch" "$root/usr/share/doc/zlib1g"
cp libz.so.1.4 "$root/usr/lib/$multiarch/libz.so.1.4"
ln -s libz.so.1.4 "$root/usr/lib/$multiarch/libz.so.1"
cp LICENSE "$root/usr/share/doc/zlib1g/copyright"
cat > "$root/DEBIAN/control" <<CONTROL
Package: zlib1g
Source: zlib
Version: 1:1.4-0videoq1
Architecture: $arch
Maintainer: VideoQ <security@videoq.jp>
Section: libs
Priority: optional
Depends: libc6 (>= 2.34)
Description: zlib 1.4 shared library built by VideoQ from official sources
 Fixes the gzwrite buffer overflow (CVE-2026-76844/CVE-2026-85091).
CONTROL
cat > "$root/usr/share/doc/zlib1g/source" <<'SOURCE'
Source: https://zlib.net/fossils/zlib-1.4.tar.gz
SHA-256: 02dd159783677a749c04adbdd02b55b8a2bcc7e054f51b76b549199a916ad584
Build: apps/inference/whisper/security/build-zlib.sh
SOURCE
dpkg-deb --build "$root" /tmp/zlib1g.deb
