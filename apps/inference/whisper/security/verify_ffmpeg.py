"""Verify the shipped source-built FFmpeg cannot enter network/RTSP code paths."""
import subprocess
import shlex
from pathlib import Path

protocols = subprocess.check_output(['ffmpeg', '-hide_banner', '-protocols'], text=True)
assert {line.strip() for line in protocols.splitlines()} <= {'Supported file protocols:', 'Input:', 'Output:', 'file', 'pipe', ''}, protocols
demuxers = subprocess.check_output(['ffmpeg', '-hide_banner', '-demuxers'], text=True)
assert not any(line.split()[-1:] == ['rtsp'] or 'RTSP input' in line for line in demuxers.splitlines())
configuration = shlex.split(subprocess.check_output(['ffmpeg', '-hide_banner', '-buildconf'], text=True))
assert '--disable-network' in configuration and '--disable-demuxer=rtsp' in configuration
source = Path('/usr/share/doc/videoq-ffmpeg/source').read_text()
assert '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e' in source
wav = subprocess.check_output(['ffmpeg', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.01', '-f', 'wav', 'pipe:1'])
assert wav[:4] == b'RIFF' and len(wav) > 44
png = subprocess.check_output(['ffmpeg', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=16x16', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'])
assert png.startswith(b'\x89PNG\r\n\x1a\n')
mp3 = subprocess.check_output(['ffmpeg', '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.1', '-acodec', 'mp3', '-f', 'mp3', 'pipe:1'])
assert len(mp3) > 100
print('FFmpeg source hash, file/pipe-only protocols, WAV/MP3 and PNG generation verified')
