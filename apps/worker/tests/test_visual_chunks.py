import json
import shutil
import struct
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from worker_python.pipeline import visual_chunks as chunks
from worker_python.pipeline.media_process import media_failure


def unpack(path):
    value = path.read_bytes()
    length = struct.unpack('<I', value[8:12])[0]
    return json.loads(value[12:12 + length]), value


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg required')
def test_audio_padding_after_last_video_frame_publishes_an_empty_tail(tmp_path):
    source = tmp_path / 'audio-tail.mp4'
    subprocess.run([
        'ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
        'color=c=blue:size=160x90:rate=1:duration=60', '-f', 'lavfi', '-i',
        'sine=duration=60.023242', '-c:v', 'mpeg4', '-c:a', 'aac', str(source),
    ], check=True)
    for index, expected_count in [(0, 60), (1, 0)]:
        with chunks.build_visual_chunk(source, 42, 60.024, index) as (pack, sparse, count):
            manifest, _ = unpack(pack)
            assert count == expected_count
            assert len(manifest['frames']) == expected_count
            if index == 1:
                assert json.loads(sparse) == []


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg required')
def test_real_chunks_keep_global_pts_offsets_tail_and_valid_image_ranges(tmp_path):
    source = tmp_path / 'delayed.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
                    'testsrc2=size=160x90:rate=10:duration=123.4', '-f', 'lavfi', '-i',
                    'sine=duration=125.4', '-vf', 'setpts=PTS+2/TB', '-fps_mode', 'vfr',
                    '-c:v', 'mpeg4', '-c:a', 'aac', str(source)], check=True)
    times = []
    for index, expected in [(0, list(range(2, 60))), (1, list(range(60, 120))), (2, list(range(120, 126)))]:
        with chunks.build_visual_chunk(source, 42, 125.4, index) as (pack, sparse, count):
            manifest, raw = unpack(pack)
            actual = [row[0] / 1000 for row in manifest['frames']]
            assert actual == expected
            assert count == len(expected)
            times.extend(actual)
            for frame in json.loads(sparse):
                image = raw[frame['offset']:frame['offset'] + frame['length']]
                assert image.startswith(b'\xff\xd8\xff') and image.endswith(b'\xff\xd9')
    assert times == list(range(2, 126))


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg required')
@pytest.mark.parametrize('rate', [1, 30])
def test_reference_frame_optimization_preserves_each_second_and_a_brief_event(tmp_path, monkeypatch, rate):
    source = tmp_path / 'b-frames.mp4'
    subprocess.run([
        'ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
        f'color=c=blue:size=160x90:rate={rate}:duration=8',
        '-vf', "drawbox=color=red:t=fill:enable='gte(t,3)*lt(t,4)'",
        '-c:v', 'mpeg4', '-bf', '2', '-g', '120', '-q:v', '2', str(source),
    ], check=True)
    calls = []
    run = chunks.run_media_process
    def record(command, **kwargs):
        calls.append('-skip_frame' in command)
        return run(command, **kwargs)
    monkeypatch.setattr(chunks, 'run_media_process', record)
    with chunks.build_visual_chunk(source, 42, 8, 0) as (pack, _, count):
        manifest, raw = unpack(pack)
        length = struct.unpack('<I', raw[8:12])[0]
        assert count == 8
        assert [time // 1000 for time, _, _ in manifest['frames']] == list(range(8))
        time, offset, size = manifest['frames'][3]
        jpeg = raw[12 + length + offset:12 + length + offset + size]
        rgb = subprocess.check_output([
            'ffmpeg', '-v', 'error', '-i', 'pipe:0', '-vf', 'scale=1:1',
            '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
        ], input=jpeg)
        assert 3000 <= time < 4000
        assert rgb[0] > 200 and rgb[2] < 30
    # A 1fps B-frame source needs its non-reference frames to preserve coverage.
    assert calls == ([True, False] if rate == 1 else [True])


def test_seeks_at_input_and_stops_output_without_filtering_away_the_stop_frame(monkeypatch, tmp_path):
    def run(command, **kwargs):
        assert command.index('-ss') < command.index('-i')
        assert command[command.index('-ss') + 1] == '5400'
        assert command[command.index('-to') + 1] == '5460.000000'
        # Filtering out frames after the end would prevent FFmpeg reaching -to
        # and make it decode the rest of a multi-hour source unnecessarily.
        assert 'lt(t,' not in command[command.index('-vf') + 1]
        assert kwargs['timeout_seconds'] == 300
        return SimpleNamespace(returncode=-9, stderr='')
    monkeypatch.setattr(chunks, 'run_media_process', run)
    with pytest.raises(RuntimeError, match='SIGKILL'):
        with chunks.build_visual_chunk(tmp_path / 'video', 42, 9289.617, 90):
            pass


def test_signal_diagnostic_redacts_private_media_url():
    assert media_failure('Extraction', SimpleNamespace(returncode=-9, stderr='https://example.test/file?secret=value')) == 'Extraction failed (signal SIGKILL): [media URL]'


@pytest.mark.parametrize('duration,index', [(0, 0), (36001, 0), (float('nan'), 0), (10, 1), (10, -1), (10, True)])
def test_invalid_ranges_do_not_spawn_a_decoder(tmp_path, duration, index):
    with pytest.raises(ValueError):
        with chunks.build_visual_chunk(tmp_path / 'missing', 42, duration, index):
            pass
