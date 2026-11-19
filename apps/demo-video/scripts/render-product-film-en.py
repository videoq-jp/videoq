#!/usr/bin/env python3
"""Render the current English product overview from reviewed UI captures.

Requires macOS's Samantha voice, Pillow, ffmpeg and ffprobe. The storyboard,
translated UI captures and lesson are committed, so rendering needs no account.
"""
import argparse
import hashlib
import json
import math
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT.parent / 'web'
CONTENT = ROOT / 'content/product-film-en.json'
ASSETS = ROOT / 'public/product-film-en/screens'
REVIEW = ROOT / 'review/product-film-en'
BLUE = '#2436df'
INK = '#222b41'
FONT = Path('/System/Library/Fonts/Supplemental')


def run(*args):
    subprocess.run([str(a) for a in args], check=True)


def duration(path):
    return float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)]))


def font(size, bold=False):
    return ImageFont.truetype(str(FONT / ('Arial Bold.ttf' if bold else 'Arial.ttf')), size)


def slide(scene, number, shot, destination, total):
    image = Image.new('RGB', (1920, 1080), '#f8faff')
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((84, 35, 730, 96), radius=3, fill=BLUE)
    draw.text((108, 50), 'Your lecture videos. Your learning partner.', font=font(27, True), fill='white')
    draw.text((1674, 37), 'VideoQ', font=font(48, True), fill=BLUE)
    draw.text((84, 118), f'{number:02d}   {scene["title"]}', font=font(36, True), fill=INK)
    capture = Image.open(ASSETS / f'{shot}.webp').convert('RGB')
    capture.thumbnail((1476, 738), Image.Resampling.LANCZOS)
    x, y = (1920 - capture.width) // 2, 185 + (738 - capture.height) // 2
    draw.rounded_rectangle((x - 1, y - 1, x + capture.width + 1, y + capture.height + 1), radius=12, fill='#cdd4e2')
    image.paste(capture, (x, y))
    draw.text((960, 936), 'English UI replay · Translated recorded answer · Demo learner data', font=font(20), fill='#697285', anchor='mt')
    draw.text((960, 972), scene['summary'], font=font(29, True), fill=BLUE, anchor='mt')
    draw.line((84, 1035, 1836, 1035), fill='#dbe0ee', width=2)
    draw.line((84, 1035, int(84 + 1752 * number / total), 1035), fill=BLUE, width=2)
    draw.text((84, 1048), 'Current app screens · Synthesized English narration · Edited pacing', font=font(17), fill='#697285')
    draw.text((1836, 1048), 'VideoQ product overview', font=font(17), fill='#697285', anchor='rt')
    image.save(destination)


def stamp(value):
    milliseconds = round(value * 1000)
    seconds, ms = divmod(milliseconds, 1000)
    minutes, sec = divmod(seconds, 60)
    hours, minute = divmod(minutes, 60)
    return f'{hours:02}:{minute:02}:{sec:02}.{ms:03}'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    data = json.loads(CONTENT.read_text())
    REVIEW.mkdir(parents=True, exist_ok=True)
    cues, scenes, elapsed = [], [], 0.0
    for i, scene in enumerate(data['scenes'], 1):
        pieces, cursor = [], 0.4
        silence = REVIEW / 'pause.wav'
        if not silence.exists():
            run('ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.4', silence)
        pieces.append(silence)
        for j, sentence in enumerate(scene['sentences']):
            key = hashlib.sha256(f"{data['voice']}:{data['rate']}:{sentence}".encode()).hexdigest()[:12]
            speech = REVIEW / f'{i:02}-{j:02}-{key}.aiff'
            if not speech.exists():
                run('say', '-v', data['voice'], '-r', data['rate'], '-o', speech, sentence)
            wav_speech = speech.with_suffix('.wav')
            run('ffmpeg', '-y', '-loglevel', 'error', '-i', speech, '-ar', '44100', '-ac', '1', wav_speech)
            length = duration(wav_speech)
            cues.append((elapsed + cursor, elapsed + cursor + length, sentence))
            pieces.extend([wav_speech, silence])
            cursor += length + .4
        length = math.ceil((cursor + .6) * 30) / 30
        audio_list = REVIEW / f'audio-{i:02}.txt'
        audio_list.write_text(''.join(f"file '{piece.name}'\n" for piece in pieces))
        wav = REVIEW / f'audio-{i:02}.wav'
        run('ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', audio_list, '-af', f'apad=whole_dur={length}', '-t', length, '-ar', '44100', '-ac', '1', wav)
        shots = []
        for j, shot in enumerate(scene['shots']):
            frame = REVIEW / f'slide-{i:02}-{j:02}.png'
            slide(scene, i, shot, frame, len(data['scenes']))
            shots.append(frame)
        scenes.append({'number': i, 'start': elapsed, 'duration': length, 'shots': shots, 'audio': wav})
        elapsed += length
    vtt = 'WEBVTT\n\n' + '\n'.join(f'{stamp(start)} --> {stamp(end)}\n{text}\n' for start, end, text in cues)
    (REVIEW / 'captions.vtt').write_text(vtt)
    (REVIEW / 'timing.json').write_text(json.dumps({'duration': elapsed, 'scenes': [{k: v for k, v in s.items() if k not in ('shots', 'audio')} for s in scenes]}, indent=2))
    if args.prepare_only:
        print(f'Prepared {elapsed:.2f} seconds of English narration and review slides.')
        return
    clips = []
    for scene in scenes:
        for j, frame in enumerate(scene['shots']):
            clip = REVIEW / f'clip-{scene["number"]:02}-{j:02}.mp4'
            length = scene['duration'] / len(scene['shots'])
            run('ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', frame,
                '-t', length, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-an', clip)
            clips.append(clip)
    video_list, audio_list = REVIEW / 'video.txt', REVIEW / 'audio.txt'
    video_list.write_text(''.join(f"file '{clip.name}'\n" for clip in clips))
    audio_list.write_text(''.join(f"file '{s['audio'].name}'\n" for s in scenes))
    speech = REVIEW / 'narration.wav'
    run('ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', audio_list, '-c:a', 'pcm_s16le', speech)
    candidate = REVIEW / 'provider-demo-en.mp4'
    run('ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', video_list,
        '-i', speech, '-stream_loop', '-1', '-i', ROOT / 'public/audio/ambient.mp3',
        '-filter_complex', f'[2:a]volume=0.07,afade=t=out:st={elapsed-2}:d=2[m];[1:a][m]amix=inputs=2:duration=first:normalize=0[a]',
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-t', elapsed, '-movflags', '+faststart', candidate)
    if candidate.stat().st_size >= 16 * 1024 * 1024:
        raise RuntimeError('Video exceeds the media route limit; candidate was not exported.')
    actual = duration(candidate)
    if abs(actual - elapsed) > .1:
        raise RuntimeError(f'Unexpected duration: {actual}, wanted {elapsed}')
    # Decode every frame and check dimensions, header, flashes and fast start.
    timeline = REVIEW / 'verification-timeline.json'
    timeline.write_text(json.dumps({'duration': elapsed, 'fps': 30, 'outro': scenes[-1]['start'], 'outroEnd': scenes[-1]['start']}))
    run('python3', ROOT / 'scripts/verify-video.py', candidate, timeline)
    # Decode the audio stream too; the frame verifier inspects video only.
    run('ffmpeg', '-v', 'error', '-xerror', '-i', candidate, '-f', 'null', '-')
    destination = WEB / 'public/demo'
    (destination / 'provider-demo-en.mp4').write_bytes(candidate.read_bytes())
    (destination / 'provider-demo-en.vtt').write_text(vtt)
    Image.open(scenes[0]['shots'][0]).save(destination / 'provider-demo-en-poster.webp', quality=88)
    metadata_path = WEB / 'src/lib/providerDemoMetadata.json'
    metadata = json.loads(metadata_path.read_text())
    metadata['en'] = {'version': 5, 'duration': round(actual), 'uploadDate': data['date']}
    metadata_path.write_text(json.dumps(metadata, indent=2) + '\n')
    print(f'Exported {actual:.2f}s, {candidate.stat().st_size / 1024**2:.2f} MiB. All streams decoded successfully.')


if __name__ == '__main__':
    main()
