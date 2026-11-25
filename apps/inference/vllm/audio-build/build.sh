#!/usr/bin/env bash
set -euo pipefail
umask 022
export PATH="/opt/python/cp312-cp312/bin:$PATH"
export SOURCE_DATE_EPOCH=1795133016 PYTHONHASHSEED=0 TZ=UTC LC_ALL=C
export CFLAGS="-O2 -ffile-prefix-map=/build=. -fdebug-prefix-map=/build=."
export CXXFLAGS="$CFLAGS"
export PIP_NO_INDEX=1 PIP_DISABLE_PIP_VERSION_CHECK=1
mkdir /build /out /out/wheels /out/fixtures
cp /recipe/source-verification.json /out/source-verification.json
python /recipe/recipe.py verify-archives --directory /inputs > /out/offline-input-verification.json
python -m pip install --no-index --no-deps --require-hashes --find-links /inputs -r /recipe/build-requirements.txt
python /recipe/recipe.py extract --archive /inputs/ffmpeg-9.1.tar.xz --destination /build/ffmpeg
python /recipe/recipe.py extract --archive /inputs/av-19.0.2.tar.gz --destination /build/pyav
cd /build/ffmpeg/ffmpeg-9.1
./configure --prefix=/opt/ffmpeg --libdir=/opt/ffmpeg/lib \
  --enable-shared --disable-static --disable-programs --disable-doc --disable-debug \
  --disable-autodetect --disable-network --disable-everything --disable-x86asm \
  --enable-protocol=file,pipe --enable-demuxer=mp3,wav,flac \
  --enable-decoder=mp3,mp3float,pcm_s16le,flac --enable-parser=mpegaudio,flac \
  --enable-filter=aformat,aresample
make -j2
make install
cp ffbuild/config.log /out/ffmpeg-config.log
cp config.h /out/ffmpeg-config.h
cp ffbuild/config.mak /out/ffmpeg-config.mak
export PKG_CONFIG_PATH=/opt/ffmpeg/lib/pkgconfig
export LD_LIBRARY_PATH=/opt/ffmpeg/lib
cd /build/pyav/av-19.0.2
python -m pip wheel --no-build-isolation --no-deps --no-index --wheel-dir /build/raw-wheel .
auditwheel show /build/raw-wheel/*.whl > /out/auditwheel.txt
auditwheel repair --plat manylinux_2_28_x86_64 --wheel-dir /out/wheels /build/raw-wheel/*.whl
# Test the repaired bundled wheel, with the build prefix hidden and no loader
# override. A missing ELF closure must fail instead of resolving build libraries.
unset LD_LIBRARY_PATH PKG_CONFIG_PATH
mv /opt/ffmpeg /opt/ffmpeg-build-prefix-hidden
python -m pip install --no-index --no-deps /out/wheels/*.whl
cp /inputs/extra_overread.mp3 /inputs/luckynight.flac /out/fixtures/
cp /recipe/verify.py /recipe/source-lock.json /out/
python /recipe/recipe.py provenance --output /out
cd /out
python /out/verify.py --output /out/build-smoke.json
