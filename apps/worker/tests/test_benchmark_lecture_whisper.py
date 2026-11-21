"""Checkpoint tests prevent duplicate paid calls after an interrupted lecture run."""
import importlib.util
import json
from pathlib import Path
import sys
from contextlib import nullcontext

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/benchmark_lecture_whisper.py'
spec = importlib.util.spec_from_file_location('benchmark_lecture', SCRIPT)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def test_resume_preserves_completed_chunks_and_rejects_another_source(monkeypatch, tmp_path):
    video = tmp_path / 'video.mp4'
    video.write_bytes(b'lecture')
    output = tmp_path / 'private' / 'result.json'
    monkeypatch.setattr(sys, 'argv', ['benchmark', '--video', str(video), '--output', str(output)])
    monkeypatch.setattr(benchmark, '_ffprobe_duration', lambda _: 360)
    extracted = []
    def extract(source, target):
        extracted.append(source)
        target.write_bytes(b'audio')
    monkeypatch.setattr(benchmark, '_ffmpeg_extract_mp3', extract)
    monkeypatch.setattr(benchmark, '_split_audio_chunks', lambda audio, chunk_seconds: ((offset, audio) for offset in (0, 300)))
    monkeypatch.setattr(benchmark, 'create_client', nullcontext)
    calls = []
    def fail_second(client, audio, model, offset, language):
        calls.append(offset)
        if offset == 300:
            raise RuntimeError('interrupted')
        return [{'start': 1, 'end': 5, 'text': 'first'}]
    monkeypatch.setattr(benchmark, '_whisper_file', fail_second)
    with pytest.raises(RuntimeError, match='interrupted'):
        benchmark.main()
    report = json.loads(output.read_text())
    assert not report['complete']
    assert len(report['chunks']) == 1
    monkeypatch.setattr(benchmark, '_whisper_file', lambda client, audio, model, offset, language: calls.append(offset) or [{'start': offset+1, 'end': offset+5, 'text': 'resumed'}])
    assert benchmark.main() == 0
    assert calls == [0, 300, 300]
    assert len(extracted) == 1
    assert json.loads(output.read_text())['complete']
    assert not output.with_suffix('.audio.mp3').exists()
    assert benchmark.main() == 0
    assert calls == [0, 300, 300]
    failed_report = json.loads(output.read_text())
    failed_report['chunks'][0]['out_of_bounds_segments'] = 1
    output.write_text(json.dumps(failed_report))
    assert benchmark.main() == 1
    assert calls == [0, 300, 300]
    video.write_bytes(b'another lecture')
    with pytest.raises(RuntimeError, match='checkpoint does not match'):
        benchmark.main()
