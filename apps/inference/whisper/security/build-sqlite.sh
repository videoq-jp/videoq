#!/bin/sh
set -eu

# Debian trixie's SQLite has no fix for CVE-2026-119373 yet. Build the
# official fixed library; shell.c is deliberately never compiled or installed.
curl -fsSL https://sqlite.org/2026/sqlite-autoconf-3540100.tar.gz -o /tmp/sqlite.tar.gz
python - <<'PY'
import hashlib
from pathlib import Path
assert hashlib.sha3_256(Path('/tmp/sqlite.tar.gz').read_bytes()).hexdigest() == 'b6ced585c750916b1052667239a12c25a7ff34e7f06e1e6e01ecb0427657d9c4', 'SQLite source checksum mismatch'
PY
tar -xzf /tmp/sqlite.tar.gz -C /tmp
arch=$(dpkg --print-architecture)
multiarch=$(gcc -dumpmachine)
root=/tmp/sqlite-package
mkdir -p "$root/DEBIAN" "$root/usr/lib/$multiarch" "$root/usr/share/doc/libsqlite3-0"
gcc -shared -fPIC -O2 -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_COLUMN_METADATA \
    -Wl,-soname,libsqlite3.so.0 -Wl,-z,relro,-z,now \
    /tmp/sqlite-autoconf-3540100/sqlite3.c -o "$root/usr/lib/$multiarch/libsqlite3.so.0" -lm -ldl -pthread
cat > "$root/DEBIAN/control" <<EOF
Package: libsqlite3-0
Source: sqlite3
Version: 3.54.1-0videoq1
Architecture: $arch
Maintainer: VideoQ <security@videoq.jp>
Section: libs
Priority: optional
Depends: libc6 (>= 2.34)
Description: SQLite 3.54.1 shared library built by VideoQ from official sources
 Includes FTS5; does not include the SQLite command-line shell.
EOF
cat > "$root/usr/share/doc/libsqlite3-0/copyright" <<'EOF'
SQLite is in the public domain: https://sqlite.org/copyright.html
Source: https://sqlite.org/2026/sqlite-autoconf-3540100.tar.gz
SHA3-256: b6ced585c750916b1052667239a12c25a7ff34e7f06e1e6e01ecb0427657d9c4
Build: apps/inference/whisper/security/build-sqlite.sh
EOF
dpkg-deb --build "$root" /tmp/libsqlite3.deb
