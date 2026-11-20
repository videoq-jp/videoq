import math
import pytest
from worker_python.domain.transcription_segments import segments_within_interval


def test_only_intersecting_nonempty_evidence_is_retained_without_mutating_inputs():
    segments = [
        {'start': 8, 'end': 12, 'text': ' leading '},
        {'start': 13, 'end': 16, 'text': 'inside'},
        {'start': 18, 'end': 23, 'text': 'trailing'},
        {'start': 0, 'end': 10, 'text': 'before'},
        {'start': 20, 'end': 25, 'text': 'after'},
        {'start': 12, 'end': 12, 'text': 'zero'},
        {'start': 15, 'end': 11, 'text': 'reverse'},
        {'start': 11, 'end': 12, 'text': ' \n '},
    ]
    assert segments_within_interval(segments, 10, 10) == [
        {'start': 10, 'end': 12, 'text': ' leading '},
        {'start': 13, 'end': 16, 'text': 'inside'},
        {'start': 18, 'end': 20, 'text': 'trailing'},
    ]
    assert segments[0]['start'] == 8
    assert segments[2]['end'] == 23


@pytest.mark.parametrize('field', ['start', 'end'])
@pytest.mark.parametrize('value', [math.nan, math.inf, -math.inf])
def test_nonfinite_timestamps_fail_instead_of_inventing_source_evidence(field, value):
    segment = {'start': 11, 'end': 12, 'text': 'speech', field: value}
    with pytest.raises(RuntimeError, match='Whisper returned non-finite timestamps'):
        segments_within_interval([segment], 10, 10)
