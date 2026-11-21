"""Read-only, resumable Workers AI evaluation of an operator-selected lecture.

Outputs contain private transcript text: keep them outside version control.
A baseline transcript is comparison evidence, not assumed ground truth.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import time

from worker_python.pipeline.transcription import _ffmpeg_extract_mp3, _ffprobe_duration, _split_audio_chunks, _whisper_file
from worker_python.pipeline.workers_ai_whisper import create_client, MODEL


def write_report(path: Path, report: dict) -> None:
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--language', default='ja')
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with args.video.open('rb') as source:
        fingerprint = hashlib.file_digest(source, 'sha256').hexdigest()
    identity = {'source_sha256': fingerprint, 'model': MODEL, 'language': args.language,
                'vad_filter': True, 'condition_on_previous_text': False, 'chunk_seconds': 300}
    if args.output.exists():
        report = json.loads(args.output.read_text())
        if report.get('identity') != identity:
            raise RuntimeError('Existing checkpoint does not match source or inference settings')
    else:
        report = {'identity': identity, 'source_seconds': _ffprobe_duration(args.video),
                  'complete': False, 'chunks': []}
        write_report(args.output, report)
    if report['complete']:
        print(json.dumps({'status': 'already_complete', 'chunks': len(report['chunks'])}))
        return int(any(c['out_of_bounds_segments'] for c in report['chunks']))
    audio = args.output.with_suffix('.audio.mp3')
    if not audio.exists():
        pending_audio = audio.with_suffix('.partial.mp3')
        _ffmpeg_extract_mp3(args.video, pending_audio)
        pending_audio.chmod(0o600)
        pending_audio.replace(audio)
    with create_client() as client, closing(_split_audio_chunks(audio, chunk_seconds=300)) as chunks:
        for offset, chunk in chunks:
            if any(c['offset_seconds'] == offset for c in report['chunks']):
                continue
            started = time.perf_counter()
            segments = _whisper_file(client, chunk, MODEL, offset=offset, language=args.language)
            upper = min(offset + 300, report['source_seconds'])
            outside = sum(not (offset <= s['start'] < s['end'] <= upper + 0.25) for s in segments)
            report['chunks'].append({'offset_seconds': offset, 'elapsed_seconds': time.perf_counter()-started,
                                     'out_of_bounds_segments': outside, 'segments': segments})
            write_report(args.output, report)
            print(json.dumps({'status': 'chunk_complete', 'offset_seconds': offset,
                              'segment_count': len(segments), 'out_of_bounds_segments': outside}), flush=True)
    report['complete'] = True
    report['estimated_inference_usd'] = report['source_seconds'] / 60 * 0.000513
    write_report(args.output, report)
    audio.unlink(missing_ok=True)
    return int(any(c['out_of_bounds_segments'] for c in report['chunks']))


if __name__ == '__main__':
    raise SystemExit(main())
