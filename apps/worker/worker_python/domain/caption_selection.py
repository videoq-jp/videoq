"""Preserve manual-first and English-first caption selection independently of HTTP."""
def caption_track_candidates(tracks: list[dict]) -> list[dict]:
    selected = []
    for kind in ('manual', 'auto'):
        candidates = [track for track in tracks if track.get('kind') == kind]
        candidates.sort(key=lambda track: str(track.get('code', '')).removeprefix('asr-').split('-')[0].lower() != 'en')
        selected.extend(candidates[:1])
    return selected
