"""Checkpoint invariants without persistence or provider dependencies."""
from dataclasses import replace

import pytest

from worker_python.domain.transcription_checkpoints import (
    TranscriptionRun, assemble_segments, can_reject_source, can_resume,
    checkpoint_count, run_is_current, source_duration_ms, terminal_chunk_failure,
    validate_chunk_seconds,
)

RUN = TranscriptionRun(42, 'run', 'file', 'revision', 600001, 300, 3, False)


@pytest.mark.parametrize('duration', [0, -1, float('inf'), float('nan'), 3000000.001])
def test_invalid_duration_precedes_missing_source(duration):
    with pytest.raises(ValueError, match='duration'):
        source_duration_ms(duration, None, None)


def test_rounding_and_checkpoint_limit():
    assert source_duration_ms(600.0001, 'file', 'revision') == 600001
    assert checkpoint_count(600001, 300) == 3
    assert checkpoint_count(3000000000, 300) == 10000
    with pytest.raises(ValueError, match='10,000'):
        checkpoint_count(300000001, 30)
    with pytest.raises(ValueError, match='fingerprint'):
        source_duration_ms(1, 'file', '')


@pytest.mark.parametrize('seconds', [29, 301])
def test_bounded_chunk_configuration(seconds):
    with pytest.raises(ValueError, match='30 to 300'):
        validate_chunk_seconds(seconds)


def test_resume_preserves_plan_but_rejects_completed_or_replaced_source():
    assert can_resume(RUN, 'file', 'revision')
    assert not can_resume(replace(RUN, completed=True), 'file', 'revision')
    assert not can_resume(RUN, 'replacement', 'revision')
    assert not can_resume(RUN, 'file', 'edited')
    assert not can_resume(None, 'file', 'revision')


@pytest.mark.parametrize('change', [
    {'status': 'indexing'}, {'status': 'completed'}, {'file_key': 'replacement'},
    {'transcript_hash': 'edited'}, {'run_id': 'new-run'}, {'completed': True},
])
def test_stale_run_cannot_write(change):
    current = dict(status='processing', file_key='file', transcript_hash='revision', run_id='run', completed=False)
    assert run_is_current(RUN, **current)
    assert not run_is_current(RUN, **(current | change))


def test_scoped_rejection_requires_incomplete_matching_run():
    source = dict(status='error', file_key='file', transcript_hash='revision',
                  expected_file='file', expected_hash='revision', run_id='run', completed=True)
    assert can_reject_source(**source, expected_run_id=None)
    assert not can_reject_source(**source, expected_run_id='run')
    assert not can_reject_source(**(source | {'completed': False}), expected_run_id='old-run')


def test_empty_audio_is_complete_but_missing_chunks_never_publish():
    segment = {'start': 0, 'end': 1, 'text': 'spoken'}
    assert assemble_segments(2, [[], [segment]]) == [segment]
    assert assemble_segments(2, [[], None]) is None
    assert assemble_segments(2, [[]]) is None
    assert assemble_segments(1, [[], []]) is None


def test_failure_threshold_index_and_diagnostic_length():
    assert terminal_chunk_failure(0, 4, 'error') is None
    assert terminal_chunk_failure(2, 5, 'x' * 1001) == 'Transcription chunk 3 failed: ' + 'x' * 1000
