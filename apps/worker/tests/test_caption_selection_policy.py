from worker_python.domain.caption_selection import caption_track_candidates


def test_manual_before_automatic_and_english_first_with_stable_fallback():
    tracks = [{'kind': 'auto', 'code': 'asr-en'}, {'kind': 'manual', 'code': 'ja'},
              {'kind': 'manual', 'code': 'en-US'}, {'kind': 'manual', 'code': 'en-GB'}]
    assert caption_track_candidates(tracks) == [tracks[2], tracks[0]]
    assert caption_track_candidates([tracks[1]]) == [tracks[1]]
    assert caption_track_candidates([{'kind': 'unknown', 'code': 'en'}]) == []
